import { CatalogRefreshServiceImpl, vectorMetadataFor } from "../src/services/catalog/CatalogRefreshServiceImpl";
import { IMoodSource, MoodDescriber } from "../src/services/catalog/MoodDescriber";
import { TmdbClient, TmdbDiscoverPage, TmdbMovieDetails, TmdbProviderKind, TmdbProviderRef, TmdbTvDetails } from "../src/services/catalog/TmdbClient";
import { ICatalogItem, ICatalogItemDraft, IWhyEntry } from "../src/services/catalog/domain/items";
import { IProvider, IProvidersItem } from "../src/services/catalog/domain/types";
import { CatalogSource, ICatalogDraft, ICatalogPage, ICatalogRef } from "../src/services/catalog/sources/CatalogSource";
import { TmdbMovieSource } from "../src/services/catalog/sources/TmdbMovieSource";
import { TmdbTvSource } from "../src/services/catalog/sources/TmdbTvSource";
import { slugify } from "../src/services/catalog/sources/tmdbShared";
import { CatalogItemRepository } from "../src/services/catalog/store/CatalogItemRepository";
import { ConfigRepository } from "../src/services/config/ConfigRepository";
import { EMediaType } from "../src/services/media/MediaType";
import { ProviderRepository } from "../src/services/providers/ProviderRepository";
import { Embedder } from "../src/services/recommendations/Embedder";
import { AssetStore } from "../src/services/storage/AssetStore";
import { IVectorMatch, IVectorRecord, VectorIndex } from "../src/services/vectors/VectorIndex";

// ---------- fakes shared by the orchestration tests ----------

/** A source that serves pre-baked drafts: `pages[page]` lists source ids, `drafts[id]` the draft. */
class FakeSource implements CatalogSource {
    public discoverCalls: { country: string; page: number }[] = [];
    public providerCalls: string[] = [];

    constructor(
        public readonly id: string,
        private readonly pages: Record<number, string[]>,
        private readonly totalPages: number,
        private readonly drafts: Record<string, ICatalogDraft>,
        private readonly providers: IProvider[] = [],
        private readonly onDiscover: () => void = () => {},
    ) {}

    async discover(country: string, page: number): Promise<ICatalogPage> {
        this.discoverCalls.push({ country, page });
        this.onDiscover();
        return { refs: (this.pages[page] ?? []).map(sourceId => ({ sourceId })), totalPages: this.totalPages };
    }

    async fetch(ref: ICatalogRef): Promise<ICatalogDraft | null> {
        return this.drafts[ref.sourceId] ?? null;
    }

    async listProviders(country: string): Promise<IProvider[]> {
        this.providerCalls.push(country);
        return this.providers;
    }
}

function draft(source: string, sourceId: string, mediaType: EMediaType = EMediaType.MOVIE, overrides: Partial<ICatalogItemDraft> = {}): ICatalogDraft {
    const itemId = `${mediaType}:${source}:${sourceId}`;
    const item: ICatalogItemDraft = {
        itemId, mediaType, title: `Title ${sourceId}`, year: 2020, runtime: 100, genres: ["comedy", "drama"], primaryGenre: "comedy",
        rating: { ZA: "13" }, popularity: 42, posterKey: `posters/${source}-${sourceId}.jpg`,
        availability: { ZA: { services: ["netflix"], links: { tmdb: "https://tmdb/watch" }, checkedAt: "t" } },
        details: { kind: "film" }, ...overrides,
    };
    return {
        item,
        moodSource: { itemId, mediaType, title: item.title, year: 2020, genres: item.genres ?? [], overview: "Overview", keywords: ["friendship"] },
        imageUrl: `https://img/${source}-${sourceId}.jpg`,
    };
}

class FakeDescriber implements MoodDescriber {
    public asked: string[][] = [];

    async describe(items: IMoodSource[]): Promise<Map<string, string>> {
        this.asked.push(items.map(item => item.itemId));
        return new Map(items.map(item => [item.itemId, `Feels like ${item.title}`]));
    }
}

class FakeEmbedder implements Embedder {
    public texts: string[] = [];

    async embed(text: string): Promise<number[]> {
        this.texts.push(text);
        return [0.5, 0.5];
    }
}

class FakeIndex implements VectorIndex {
    public upserted: IVectorRecord[] = [];
    public deleted: string[] = [];

    async upsert(records: IVectorRecord[]): Promise<void> {
        this.upserted.push(...records);
    }

    async query(): Promise<IVectorMatch[]> {
        return [];
    }

    async delete(keys: string[]): Promise<void> {
        this.deleted.push(...keys);
    }
}

class FakeStore implements CatalogItemRepository {
    public saved = new Map<string, ICatalogItemDraft>();

    constructor(existing: ICatalogItem[] = []) {
        for (const item of existing) this.saved.set(item.itemId, item);
    }

    async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        return itemIds.map(id => this.saved.get(id)).filter((item): item is ICatalogItem => Boolean(item));
    }

    async saveWhy(_itemId: string, _key: string, _entry: IWhyEntry): Promise<void> {}

    async upsertCatalog(item: ICatalogItemDraft): Promise<void> {
        this.saved.set(item.itemId, { ...this.saved.get(item.itemId), ...item });
    }
}

class FakeProviders implements ProviderRepository {
    public saved: IProvidersItem[] = [];

    async save(item: IProvidersItem): Promise<void> {
        this.saved.push(item);
    }
}

class FakeConfig implements ConfigRepository {
    public items = new Map<string, Record<string, unknown>>();

    async get(key: string): Promise<Record<string, unknown> | null> {
        return this.items.get(key) ?? null;
    }

    async put(key: string, fields: Record<string, unknown>): Promise<void> {
        this.items.set(key, { ...fields, configKey: key });
    }
}

class FakeAssets implements AssetStore {
    public stored: { url: string; key: string }[] = [];

    async ensureFromUrl(url: string, key: string): Promise<string> {
        this.stored.push({ url, key });
        return key;
    }
}

function build(sources: CatalogSource[], options: { existing?: ICatalogItem[]; countries?: string[]; clock?: () => Date } = {}) {
    const describer = new FakeDescriber();
    const embedder = new FakeEmbedder();
    const index = new FakeIndex();
    const store = new FakeStore(options.existing);
    const providers = new FakeProviders();
    const config = new FakeConfig();
    const assets = new FakeAssets();
    const service = new CatalogRefreshServiceImpl({
        sources, moodDescriber: describer, embedder, vectorIndex: index, catalogStore: store,
        providerRepository: providers, configRepository: config, assetStore: assets,
        countries: options.countries ?? ["ZA"], now: options.clock,
    });

    return { service, describer, embedder, index, store, providers, config, assets };
}

const netflix: IProvider = { id: 8, slug: "netflix", name: "Netflix", deepLinkTemplate: "https://www.netflix.com/search?q={title}" };
const showmax: IProvider = { id: 55, slug: "showmax", name: "Showmax", deepLinkTemplate: "https://www.showmax.com/eng/search?q={title}" };

describe("CatalogRefreshServiceImpl.refresh", () => {
    test("walks every page of one source and country, writes items, vectors and providers, and completes", async () => {
        const source = new FakeSource("tmdb-movie", { 1: ["1", "2"], 2: ["3"] }, 2,
            { 1: draft("tmdb-movie", "1"), 2: draft("tmdb-movie", "2"), 3: draft("tmdb-movie", "3") }, [netflix]);
        const { service, describer, index, store, providers, config, assets } = build([source]);

        const result = await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 10 });

        expect(result).toMatchObject({ status: "completed", source: "tmdb-movie", country: "ZA", page: 2, itemsProcessed: 3 });
        expect(source.discoverCalls).toEqual([{ country: "ZA", page: 1 }, { country: "ZA", page: 2 }]);
        expect(source.providerCalls).toEqual(["ZA"]);
        expect(describer.asked).toEqual([["movie:tmdb-movie:1", "movie:tmdb-movie:2"], ["movie:tmdb-movie:3"]]);

        const saved = store.saved.get("movie:tmdb-movie:1");
        expect(saved).toMatchObject({ mediaType: "movie", title: "Title 1", moodDesc: "Feels like Title 1", posterKey: "posters/tmdb-movie-1.jpg" });
        expect(saved?.embeddedAt).toBeDefined();

        expect(index.upserted.map(record => record.key)).toEqual(["movie:tmdb-movie:1", "movie:tmdb-movie:2", "movie:tmdb-movie:3"]);
        expect(index.upserted[0].metadata).toEqual({
            itemId: "movie:tmdb-movie:1", mediaType: "movie", countries: ["ZA"], availableOn: ["ZA:netflix"], ratings: ["ZA:13"],
            popularity: 42, genres: ["comedy", "drama"], runtime: 100, year: 2020, primaryGenre: "comedy",
        });
        expect(providers.saved).toEqual([expect.objectContaining({ country: "ZA", providers: [netflix] })]);
        expect(assets.stored.map(asset => asset.key)).toContain("posters/tmdb-movie-1.jpg");
        expect(config.items.get("CATALOG_CURSOR")?.completedAt).toBeDefined();
    });

    test("walks sources in order, merges their providers once per country, and tags each item with its media type", async () => {
        const movies = new FakeSource("tmdb-movie", { 1: ["1"] }, 1, { 1: draft("tmdb-movie", "1") }, [netflix]);
        const tv = new FakeSource("tmdb-tv", { 1: ["9"] }, 1, { 9: draft("tmdb-tv", "9", EMediaType.SERIES, { details: { kind: "show", episodeCount: 8 } }) }, [netflix, showmax]);
        const { service, index, providers } = build([movies, tv]);

        const result = await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 10 });

        expect(result).toMatchObject({ status: "completed", source: "tmdb-tv", itemsProcessed: 2 });
        expect(movies.discoverCalls).toEqual([{ country: "ZA", page: 1 }]);
        expect(tv.discoverCalls).toEqual([{ country: "ZA", page: 1 }]);
        expect(providers.saved).toHaveLength(1);
        expect(providers.saved[0].providers.map(provider => provider.slug)).toEqual(["netflix", "showmax"]);
        expect(index.upserted.map(record => [record.key, record.metadata.mediaType])).toEqual([
            ["movie:tmdb-movie:1", "movie"], ["series:tmdb-tv:9", "series"],
        ]);
    });

    test("reuses stored mood descriptions and removes items that are no longer available", async () => {
        const source = new FakeSource("tmdb-movie", { 1: ["1", "2"] }, 1,
            { 1: draft("tmdb-movie", "1"), 2: draft("tmdb-movie", "2", EMediaType.MOVIE, { availability: {} }) });
        const existing: ICatalogItem = { itemId: "movie:tmdb-movie:1", mediaType: EMediaType.MOVIE, title: "Title 1", moodDesc: "Cached feel", embeddedAt: "2026-09-01T00:00:00Z" };
        const { service, describer, index, store } = build([source], { existing: [existing] });

        await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 10 });

        expect(describer.asked).toEqual([["movie:tmdb-movie:2"]]);
        expect(store.saved.get("movie:tmdb-movie:1")?.moodDesc).toBe("Cached feel");
        expect(index.upserted.map(record => record.key)).toEqual(["movie:tmdb-movie:1"]);
        expect(index.deleted).toEqual(["movie:tmdb-movie:2"]);
    });

    test("pauses when the time budget is exhausted and resumes from the saved cursor", async () => {
        // Each page fetch "takes" 40 seconds; the clock is otherwise still.
        let elapsed = 0;
        const clock = () => new Date(1_000_000 + elapsed);
        const source = new FakeSource("tmdb-movie", { 1: ["1"], 2: ["2"], 3: ["3"] }, 3,
            { 1: draft("tmdb-movie", "1"), 2: draft("tmdb-movie", "2"), 3: draft("tmdb-movie", "3") }, [], () => { elapsed += 40_000; });
        const { service, config } = build([source], { clock });

        const paused = await service.refresh({ timeBudgetMs: 45_000, maxPagesPerCountry: 10 });

        expect(paused.status).toBe("paused");
        expect(config.items.get("CATALOG_CURSOR")).toMatchObject({ runId: paused.runId, page: 3 });
        expect(config.items.get("CATALOG_CURSOR")?.completedAt).toBeUndefined();

        const resumed = await service.refresh({ timeBudgetMs: 600_000, maxPagesPerCountry: 10 });

        expect(resumed.status).toBe("completed");
        expect(resumed.runId).toBe(paused.runId);
        expect(source.discoverCalls.filter(call => call.page === 1)).toHaveLength(1);
    });

    test("moves on to the next country and caps pages per country", async () => {
        const source = new FakeSource("tmdb-movie", { 1: ["1"], 2: ["2"], 3: ["3"] }, 500,
            { 1: draft("tmdb-movie", "1"), 2: draft("tmdb-movie", "2"), 3: draft("tmdb-movie", "3") }, [netflix]);
        const { service, providers } = build([source], { countries: ["ZA", "US"] });

        const result = await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 2 });

        expect(result).toMatchObject({ status: "completed", country: "US", page: 2 });
        expect(source.discoverCalls).toEqual([
            { country: "ZA", page: 1 }, { country: "ZA", page: 2 }, { country: "US", page: 1 }, { country: "US", page: 2 },
        ]);
        expect(providers.saved.map(item => item.country)).toEqual(["ZA", "US"]);
    });
});

// ---------- TMDB sources: how raw TMDB payloads become items ----------

class FakeTmdb implements TmdbClient {
    constructor(private readonly movie?: TmdbMovieDetails, private readonly tv?: TmdbTvDetails) {}

    async discoverMovies(): Promise<TmdbDiscoverPage> { return { page: 1, totalPages: 1, results: [] }; }
    async discoverTv(): Promise<TmdbDiscoverPage> { return { page: 1, totalPages: 1, results: [] }; }
    async getMovie(): Promise<TmdbMovieDetails> { return this.movie as TmdbMovieDetails; }
    async getTv(): Promise<TmdbTvDetails> { return this.tv as TmdbTvDetails; }
    async listProviders(_country: string, _kind: TmdbProviderKind): Promise<TmdbProviderRef[]> { return []; }
    imageUrl(path: string, size: string): string { return `https://img/${size}${path}`; }
}

const providersZa = { results: { ZA: { link: "https://tmdb/watch", flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png" }] } } };

describe("TmdbMovieSource", () => {
    test("types a film with the Documentary genre as a documentary and builds a routable id", async () => {
        const movie: TmdbMovieDetails = {
            id: 7, title: "Doc", overview: "o", release_date: "2019-03-02", runtime: 95, genres: [{ id: 99, name: "Documentary" }],
            popularity: 3, vote_count: 10, poster_path: "/p.jpg", keywords: { keywords: [{ name: "nature" }] },
            release_dates: { results: [{ iso_3166_1: "ZA", release_dates: [{ certification: "PG", type: 3 }] }] }, "watch/providers": providersZa,
        };
        const source = new TmdbMovieSource(new FakeTmdb(movie), new FakeAssets());

        const result = await source.fetch({ sourceId: "7" }, ["ZA"], "t");

        expect(result?.item).toMatchObject({
            itemId: "documentary:tmdb-movie:7", mediaType: "documentary", title: "Doc", year: 2019, runtime: 95, genres: ["documentary"],
            rating: { ZA: "PG" }, posterKey: "posters/tmdb-movie-7.jpg", availability: { ZA: { services: ["netflix"] } }, details: { kind: "film", voteCount: 10 },
        });
        expect(result?.moodSource).toMatchObject({ itemId: "documentary:tmdb-movie:7", mediaType: "documentary", keywords: ["nature"] });
        expect(result?.imageUrl).toBe("https://img/w500/p.jpg");
    });
});

describe("TmdbTvSource", () => {
    test("types a drama show as a series, uses the typical episode length as runtime and reads content ratings", async () => {
        const show: TmdbTvDetails = {
            id: 1399, name: "Show", overview: "o", first_air_date: "2011-04-17", episode_run_time: [50, 60], number_of_episodes: 73, number_of_seasons: 8,
            genres: [{ id: 18, name: "Drama" }], popularity: 9, vote_count: 500, poster_path: "/s.jpg", keywords: { results: [{ name: "power" }] },
            content_ratings: { results: [{ iso_3166_1: "ZA", rating: "16" }] }, "watch/providers": providersZa,
        };
        const source = new TmdbTvSource(new FakeTmdb(undefined, show), new FakeAssets());

        const result = await source.fetch({ sourceId: "1399" }, ["ZA"], "t");

        expect(result?.item).toMatchObject({
            itemId: "series:tmdb-tv:1399", mediaType: "series", title: "Show", year: 2011, runtime: 55, genres: ["drama"],
            rating: { ZA: "16" }, posterKey: "posters/tmdb-tv-1399.jpg", details: { kind: "show", episodeCount: 73, seasonCount: 8, voteCount: 500 },
        });
    });
});

describe("helpers", () => {
    test("slugify produces the identifiers users put in their services list", () => {
        expect(slugify("Amazon Prime Video")).toBe("amazon-prime-video");
        expect(slugify("Disney Plus")).toBe("disney-plus");
        expect(slugify("Apple TV+")).toBe("apple-tv");
    });

    test("vector metadata never contains empty lists, which S3 Vectors rejects", () => {
        const metadata = vectorMetadataFor({ itemId: "book:openlibrary:OL1", mediaType: EMediaType.BOOK, title: "X", availability: { US: { services: ["kindle"], checkedAt: "t" } } }, ["US"]);

        expect(metadata).toEqual({ itemId: "book:openlibrary:OL1", mediaType: "book", countries: ["US"], availableOn: ["US:kindle"], popularity: 0 });
        expect(Object.values(metadata).some(value => Array.isArray(value) && value.length === 0)).toBe(false);
    });
});
