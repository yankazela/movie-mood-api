import { ulid } from "ulid";
import { CatalogRefreshService } from "./CatalogRefreshService";
import { MoodDescriber } from "./MoodDescriber";
import { BedrockMoodDescriberImpl } from "./BedrockMoodDescriberImpl";
import { TmdbClientImpl } from "./TmdbClientImpl";
import { CatalogSource, ICatalogDraft } from "./sources/CatalogSource";
import { TmdbMovieSource } from "./sources/TmdbMovieSource";
import { TmdbTvSource } from "./sources/TmdbTvSource";
import { CatalogItemRepository } from "./store/CatalogItemRepository";
import { CatalogStore } from "./store/CatalogStore";
import { ICatalogItemDraft } from "./domain/items";
import { ICatalogCursor, IProvider, IRefreshOptions, IRefreshResult } from "./domain/types";
import { CURSOR_CONFIG_KEY, TMDB_CONCURRENCY, countriesFromEnvironment } from "./config";
import { mapWithConcurrency } from "../common/concurrency";
import { ConfigRepository } from "../config/ConfigRepository";
import { ConfigRepositoryImpl } from "../config/ConfigRepositoryImpl";
import { ProviderRepository } from "../providers/ProviderRepository";
import { ProviderRepositoryImpl } from "../providers/ProviderRepositoryImpl";
import { Embedder } from "../recommendations/Embedder";
import { TitanEmbedderImpl } from "../recommendations/TitanEmbedderImpl";
import { AssetStore } from "../storage/AssetStore";
import { S3AssetStoreImpl } from "../storage/S3AssetStoreImpl";
import { IVectorRecord, VectorIndex, VectorMetadata } from "../vectors/VectorIndex";
import { S3VectorsIndexImpl } from "../vectors/S3VectorsIndexImpl";

export interface CatalogDependencies {
    /** Sources are walked in order; each one is a medium (or part of one). */
    sources: CatalogSource[];
    moodDescriber: MoodDescriber;
    embedder: Embedder;
    vectorIndex: VectorIndex;
    catalogStore: CatalogItemRepository;
    providerRepository: ProviderRepository;
    configRepository: ConfigRepository;
    assetStore: AssetStore;
    /** Countries to catalogue, in order. */
    countries: string[];
    now?: () => Date;
}

/**
 * Walks every registered CatalogSource for every configured country, page by page. The steps
 * after fetching are the same for any medium: describe the mood once, embed it, store the item in
 * its family's table and the vector in the shared index with filterable metadata.
 */
export class CatalogRefreshServiceImpl implements CatalogRefreshService {
    private readonly deps: CatalogDependencies;
    private readonly now: () => Date;

    constructor(deps: CatalogDependencies) {
        if (deps.sources.length === 0) {
            throw new Error("At least one catalogue source is required");
        }

        this.deps = deps;
        this.now = deps.now ?? (() => new Date());
    }

    /**
     * Wires the production collaborators from the environment. To add a medium, construct its
     * source here; nothing else in the job changes.
     */
    public static async create(): Promise<CatalogRefreshServiceImpl> {
        const vectorIndex = S3VectorsIndexImpl.fromEnvironment();

        if (!vectorIndex) {
            throw new Error("VECTOR_BUCKET_NAME and VECTOR_INDEX_NAME must be set");
        }

        const assetStore = new S3AssetStoreImpl();
        const tmdb = await TmdbClientImpl.fromSecret();

        return new CatalogRefreshServiceImpl({
            sources: [new TmdbMovieSource(tmdb, assetStore), new TmdbTvSource(tmdb, assetStore)],
            moodDescriber: new BedrockMoodDescriberImpl(),
            embedder: new TitanEmbedderImpl(),
            vectorIndex,
            catalogStore: CatalogStore.fromEnvironment(),
            providerRepository: new ProviderRepositoryImpl(),
            configRepository: new ConfigRepositoryImpl(),
            assetStore,
            countries: countriesFromEnvironment(),
        });
    }

    public async refresh(options: IRefreshOptions): Promise<IRefreshResult> {
        const deadline = this.now().getTime() + options.timeBudgetMs;
        let cursor = await this.loadOrStartCursor();
        let itemsProcessed = 0;

        while (true) {
            if (this.now().getTime() >= deadline) {
                await this.saveCursor(cursor);
                return this.result("paused", cursor, itemsProcessed);
            }

            const source = this.sourceById(cursor.source);

            // Providers are refreshed once per country per run, as the first source starts it.
            if (cursor.page === 1 && source === this.deps.sources[0]) {
                await this.refreshProviders(cursor.country);
            }

            const page = await source.discover(cursor.country, cursor.page);
            itemsProcessed += await this.processPage(source, page.refs);

            const lastPage = Math.max(1, Math.min(page.totalPages, options.maxPagesPerCountry));
            const next = this.advance(cursor, lastPage);

            if (!next) {
                cursor = { ...cursor, completedAt: this.now().toISOString() };
                await this.saveCursor(cursor);
                return this.result("completed", cursor, itemsProcessed);
            }

            cursor = next;
            await this.saveCursor(cursor);
        }
    }

    /** Next page, else next country, else next source, else null when the run is complete. */
    private advance(cursor: ICatalogCursor, lastPage: number): ICatalogCursor | null {
        if (cursor.page < lastPage) {
            return { ...cursor, page: cursor.page + 1 };
        }

        const nextCountry = this.deps.countries[this.deps.countries.indexOf(cursor.country) + 1];

        if (nextCountry) {
            return { ...cursor, country: nextCountry, page: 1 };
        }

        const sourceIds = this.deps.sources.map(source => source.id);
        const nextSource = sourceIds[sourceIds.indexOf(cursor.source) + 1];

        if (nextSource) {
            return { ...cursor, source: nextSource, country: this.deps.countries[0], page: 1 };
        }

        return null;
    }

    /** Resumes an unfinished run, otherwise starts a new one at the first source, country and page. */
    private async loadOrStartCursor(): Promise<ICatalogCursor> {
        const stored = (await this.deps.configRepository.get(CURSOR_CONFIG_KEY)) as Partial<ICatalogCursor> | null;
        const resumable = stored?.runId && stored.source && stored.country && stored.page && !stored.completedAt
            && this.deps.sources.some(source => source.id === stored.source)
            && this.deps.countries.includes(stored.country);

        if (resumable) {
            return {
                runId: stored.runId as string,
                source: stored.source as string,
                country: stored.country as string,
                page: stored.page as number,
                startedAt: stored.startedAt ?? this.now().toISOString(),
            };
        }

        return {
            runId: ulid(this.now().getTime()),
            source: this.deps.sources[0].id,
            country: this.deps.countries[0],
            page: 1,
            startedAt: this.now().toISOString(),
        };
    }

    private saveCursor(cursor: ICatalogCursor): Promise<void> {
        return this.deps.configRepository.put(CURSOR_CONFIG_KEY, { ...cursor });
    }

    private result(status: IRefreshResult["status"], cursor: ICatalogCursor, itemsProcessed: number): IRefreshResult {
        return { status, runId: cursor.runId, source: cursor.source, country: cursor.country, page: cursor.page, itemsProcessed };
    }

    private sourceById(id: string): CatalogSource {
        const source = this.deps.sources.find(candidate => candidate.id === id);

        if (!source) {
            throw new Error(`Unknown catalogue source ${id}`);
        }

        return source;
    }

    /** Union of every source's providers for the country, keyed by provider id. */
    private async refreshProviders(country: string): Promise<void> {
        const byId = new Map<number, IProvider>();

        for (const source of this.deps.sources) {
            if (!source.listProviders) {
                continue;
            }

            for (const provider of await source.listProviders(country)) {
                if (!byId.has(provider.id)) {
                    byId.set(provider.id, provider);
                }
            }
        }

        await this.deps.providerRepository.save({ country, providers: [...byId.values()], refreshedAt: this.now().toISOString() });
    }

    /** Handles one page from one source: fetch, describe, poster, embed, store, index. */
    private async processPage(source: CatalogSource, refs: { sourceId: string }[]): Promise<number> {
        const checkedAt = this.now().toISOString();

        const drafts = (await mapWithConcurrency(refs, TMDB_CONCURRENCY, async ref => {
            try {
                return await source.fetch(ref, this.deps.countries, checkedAt);
            } catch (error: any) {
                console.error(`Skipping ${source.id} item ${ref.sourceId}: ${error.message}`);
                return null;
            }
        })).filter((draft): draft is ICatalogDraft => draft !== null);

        const existing = new Map(
            (await this.deps.catalogStore.findByIds(drafts.map(draft => draft.item.itemId))).map(item => [item.itemId, item]),
        );

        // Mood descriptions are the expensive step, so only items that lack one get described.
        const needingDescription = drafts.filter(draft => !existing.get(draft.item.itemId)?.moodDesc).map(draft => draft.moodSource);
        const described = needingDescription.length > 0 ? await this.deps.moodDescriber.describe(needingDescription) : new Map<string, string>();

        const records: IVectorRecord[] = [];
        const unavailable: string[] = [];

        await mapWithConcurrency(drafts, TMDB_CONCURRENCY, async draft => {
            const previous = existing.get(draft.item.itemId);
            const item: ICatalogItemDraft = {
                ...draft.item,
                moodDesc: previous?.moodDesc ?? described.get(draft.item.itemId),
                embeddedAt: previous?.embeddedAt,
                posterKey: (await this.storeImage(draft)) ?? previous?.posterKey,
            };
            const countries = Object.keys(item.availability ?? {});

            if (item.moodDesc && countries.length > 0) {
                const vector = await this.deps.embedder.embed(embeddingTextFor(item, draft.moodSource.keywords));
                records.push({ key: item.itemId, vector, metadata: vectorMetadataFor(item, countries) });
                item.embeddedAt = checkedAt;
            } else {
                unavailable.push(item.itemId);
            }

            await this.deps.catalogStore.upsertCatalog(item);
        });

        if (records.length > 0) {
            await this.deps.vectorIndex.upsert(records);
        }

        if (unavailable.length > 0) {
            await this.deps.vectorIndex.delete(unavailable).catch((error: Error) => {
                console.error("Could not remove unavailable items from the index:", error.message);
            });
        }

        return drafts.length;
    }

    private async storeImage(draft: ICatalogDraft): Promise<string | undefined> {
        if (!draft.imageUrl || !draft.item.posterKey) {
            return undefined;
        }

        try {
            return await this.deps.assetStore.ensureFromUrl(draft.imageUrl, draft.item.posterKey);
        } catch (error: any) {
            console.error(`Could not store image ${draft.item.posterKey}: ${error.message}`);
            return undefined;
        }
    }
}

/** The text whose embedding represents the item: its mood description plus genres and keywords. */
export function embeddingTextFor(item: ICatalogItemDraft, keywords: string[]): string {
    const parts = [item.moodDesc ?? ""];

    if (item.genres?.length) parts.push(`Genres: ${item.genres.join(", ")}.`);
    if (keywords.length) parts.push(`Themes: ${keywords.slice(0, 10).join(", ")}.`);

    return parts.join(" ");
}

/**
 * Filterable metadata stored with the vector; see S3VectorsCandidateRetrieverImpl for the reader.
 * S3 Vectors rejects empty arrays, so list fields are only written when they have values. An item
 * with no known rating therefore has no `ratings` key and is excluded by rating filters until the
 * rating constraint is relaxed.
 */
export function vectorMetadataFor(item: ICatalogItemDraft, countries: string[]): VectorMetadata {
    const metadata: VectorMetadata = {
        itemId: item.itemId,
        mediaType: item.mediaType,
        countries,
        popularity: item.popularity ?? 0,
    };

    const availableOn = countries.flatMap(country => (item.availability?.[country]?.services ?? []).map(service => `${country}:${service}`));
    const ratings = Object.entries(item.rating ?? {}).map(([country, rating]) => `${country}:${rating}`);

    if (availableOn.length > 0) metadata.availableOn = availableOn;
    if (ratings.length > 0) metadata.ratings = ratings;
    if (item.genres?.length) metadata.genres = item.genres;
    if (item.runtime) metadata.runtime = item.runtime;
    if (item.year) metadata.year = item.year;
    if (item.primaryGenre) metadata.primaryGenre = item.primaryGenre;

    return metadata;
}
