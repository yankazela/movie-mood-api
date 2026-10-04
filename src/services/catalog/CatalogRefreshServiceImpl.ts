import { ulid } from "ulid";
import { CatalogRefreshService } from "./CatalogRefreshService";
import { IMoodSource, MoodDescriber } from "./MoodDescriber";
import { BedrockMoodDescriberImpl } from "./BedrockMoodDescriberImpl";
import { TmdbClient, TmdbMovieDetails, TmdbMovieSummary, TmdbProviderRef } from "./TmdbClient";
import { TmdbClientImpl } from "./TmdbClientImpl";
import { ICatalogCursor, IProvider, IRefreshOptions, IRefreshResult } from "./domain/types";
import {
    CURSOR_CONFIG_KEY,
    DEEP_LINK_TEMPLATES,
    POSTER_SIZE,
    PROVIDER_LOGO_SIZE,
    TMDB_CONCURRENCY,
    countriesFromEnvironment,
} from "./config";
import { mapWithConcurrency } from "../common/concurrency";
import { ConfigRepository } from "../config/ConfigRepository";
import { ConfigRepositoryImpl } from "../config/ConfigRepositoryImpl";
import { IAvailability, IMovie } from "../movies/domain/types";
import { MovieRepository } from "../movies/MovieRepository";
import { MovieRepositoryImpl } from "../movies/MovieRepositoryImpl";
import { ProviderRepository } from "../providers/ProviderRepository";
import { ProviderRepositoryImpl } from "../providers/ProviderRepositoryImpl";
import { Embedder } from "../recommendations/Embedder";
import { TitanEmbedderImpl } from "../recommendations/TitanEmbedderImpl";
import { AssetStore } from "../storage/AssetStore";
import { S3AssetStoreImpl } from "../storage/S3AssetStoreImpl";
import { IVectorRecord, VectorIndex, VectorMetadata } from "../vectors/VectorIndex";
import { S3VectorsIndexImpl } from "../vectors/S3VectorsIndexImpl";

export interface CatalogDependencies {
    tmdb: TmdbClient;
    moodDescriber: MoodDescriber;
    embedder: Embedder;
    vectorIndex: VectorIndex;
    movieRepository: MovieRepository;
    providerRepository: ProviderRepository;
    configRepository: ConfigRepository;
    assetStore: AssetStore;
    /** Countries to catalog, in order. */
    countries: string[];
    now?: () => Date;
}

export class CatalogRefreshServiceImpl implements CatalogRefreshService {
    private readonly deps: CatalogDependencies;
    private readonly now: () => Date;

    constructor(deps: CatalogDependencies) {
        this.deps = deps;
        this.now = deps.now ?? (() => new Date());
    }

    /** Wires the production collaborators from the environment. Async because the TMDB key is a secret. */
    public static async create(): Promise<CatalogRefreshServiceImpl> {
        const vectorIndex = S3VectorsIndexImpl.fromEnvironment();

        if (!vectorIndex) {
            throw new Error("VECTOR_BUCKET_NAME and VECTOR_INDEX_NAME must be set");
        }

        return new CatalogRefreshServiceImpl({
            tmdb: await TmdbClientImpl.fromSecret(),
            moodDescriber: new BedrockMoodDescriberImpl(),
            embedder: new TitanEmbedderImpl(),
            vectorIndex,
            movieRepository: new MovieRepositoryImpl(),
            providerRepository: new ProviderRepositoryImpl(),
            configRepository: new ConfigRepositoryImpl(),
            assetStore: new S3AssetStoreImpl(),
            countries: countriesFromEnvironment(),
        });
    }

    public async refresh(options: IRefreshOptions): Promise<IRefreshResult> {
        const deadline = this.now().getTime() + options.timeBudgetMs;
        let cursor = await this.loadOrStartCursor();
        let moviesProcessed = 0;

        while (true) {
            if (this.now().getTime() >= deadline) {
                await this.saveCursor(cursor);
                return { status: "paused", runId: cursor.runId, country: cursor.country, page: cursor.page, moviesProcessed };
            }

            if (cursor.page === 1) {
                await this.refreshProviders(cursor.country);
            }

            const page = await this.deps.tmdb.discoverMovies(cursor.country, cursor.page);
            moviesProcessed += await this.processPage(page.results);

            const lastPage = Math.max(1, Math.min(page.totalPages, options.maxPagesPerCountry));

            if (cursor.page < lastPage) {
                cursor = { ...cursor, page: cursor.page + 1 };
            } else {
                const nextCountry = this.deps.countries[this.deps.countries.indexOf(cursor.country) + 1];

                if (nextCountry) {
                    cursor = { ...cursor, country: nextCountry, page: 1 };
                } else {
                    cursor = { ...cursor, completedAt: this.now().toISOString() };
                    await this.saveCursor(cursor);
                    return { status: "completed", runId: cursor.runId, country: cursor.country, page: cursor.page, moviesProcessed };
                }
            }

            await this.saveCursor(cursor);
        }
    }

    /** Resumes an unfinished run, otherwise starts a new one at the first country's first page. */
    private async loadOrStartCursor(): Promise<ICatalogCursor> {
        const stored = (await this.deps.configRepository.get(CURSOR_CONFIG_KEY)) as Partial<ICatalogCursor> | null;

        if (stored?.runId && stored.country && stored.page && !stored.completedAt && this.deps.countries.includes(stored.country)) {
            return { runId: stored.runId, country: stored.country, page: stored.page, startedAt: stored.startedAt ?? this.now().toISOString() };
        }

        return { runId: ulid(this.now().getTime()), country: this.deps.countries[0], page: 1, startedAt: this.now().toISOString() };
    }

    private saveCursor(cursor: ICatalogCursor): Promise<void> {
        return this.deps.configRepository.put(CURSOR_CONFIG_KEY, { ...cursor });
    }

    private async refreshProviders(country: string): Promise<void> {
        const refs = await this.deps.tmdb.listProviders(country);
        const sorted = [...refs].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));

        const providers = await mapWithConcurrency(sorted, TMDB_CONCURRENCY, async (ref): Promise<IProvider> => {
            const slug = slugify(ref.provider_name);

            return {
                id: ref.provider_id,
                slug,
                name: ref.provider_name,
                logoKey: await this.storeImage(ref.logo_path, PROVIDER_LOGO_SIZE, `providers/${ref.provider_id}.jpg`),
                deepLinkTemplate: DEEP_LINK_TEMPLATES[slug] ?? `https://www.themoviedb.org/movie/{tmdbId}/watch?locale=${country}`,
            };
        });

        await this.deps.providerRepository.save({ country, providers, refreshedAt: this.now().toISOString() });
    }

    /** Handles one discover page: details, mood descriptions, posters, embeddings, table and index writes. */
    private async processPage(summaries: TmdbMovieSummary[]): Promise<number> {
        const details = (await mapWithConcurrency(summaries, TMDB_CONCURRENCY, async summary => {
            try {
                return await this.deps.tmdb.getMovie(summary.id);
            } catch (error: any) {
                console.error(`Skipping TMDB movie ${summary.id}: ${error.message}`);
                return null;
            }
        })).filter((movie): movie is TmdbMovieDetails => movie !== null);

        const existing = new Map(
            (await this.deps.movieRepository.findByIds(details.map(movie => movieIdFor(movie.id)))).map(movie => [movie.movieId, movie]),
        );

        // Mood descriptions are the expensive step, so only films that lack one get described.
        const needingDescription = details
            .filter(movie => !existing.get(movieIdFor(movie.id))?.moodDesc)
            .map((movie): IMoodSource => ({
                movieId: movieIdFor(movie.id),
                title: movie.title,
                year: yearOf(movie),
                genres: genreNames(movie),
                overview: movie.overview,
                keywords: movie.keywords?.keywords.map(keyword => keyword.name) ?? [],
            }));
        const described = needingDescription.length > 0 ? await this.deps.moodDescriber.describe(needingDescription) : new Map<string, string>();

        const checkedAt = this.now().toISOString();
        const records: IVectorRecord[] = [];
        const unavailable: string[] = [];

        await mapWithConcurrency(details, TMDB_CONCURRENCY, async movie => {
            const movieId = movieIdFor(movie.id);
            const previous = existing.get(movieId);
            const moodDesc = previous?.moodDesc ?? described.get(movieId);
            const availability = this.availabilityFor(movie, checkedAt);
            const countries = Object.keys(availability);

            const item: Omit<IMovie, "why"> = {
                movieId,
                title: movie.title,
                year: yearOf(movie),
                runtime: movie.runtime ?? undefined,
                genres: genreNames(movie),
                primaryGenre: genreNames(movie)[0],
                rating: this.ratingsFor(movie),
                popularity: movie.popularity,
                voteCount: movie.vote_count,
                posterKey: (await this.storeImage(movie.poster_path, POSTER_SIZE, `posters/tmdb-${movie.id}.jpg`)) ?? previous?.posterKey,
                moodDesc,
                embeddedAt: previous?.embeddedAt,
                availability,
            };

            if (moodDesc && countries.length > 0) {
                const vector = await this.deps.embedder.embed(embeddingTextFor(item, movie));
                records.push({ key: movieId, vector, metadata: vectorMetadataFor(item, countries) });
                item.embeddedAt = checkedAt;
            } else {
                unavailable.push(movieId);
            }

            await this.deps.movieRepository.upsertCatalog(item);
        });

        if (records.length > 0) {
            await this.deps.vectorIndex.upsert(records);
        }

        if (unavailable.length > 0) {
            await this.deps.vectorIndex.delete(unavailable).catch((error: Error) => {
                console.error("Could not remove unavailable titles from the index:", error.message);
            });
        }

        return details.length;
    }

    /** Streaming availability for the configured countries, from TMDB's per-country provider lists. */
    private availabilityFor(movie: TmdbMovieDetails, checkedAt: string): Record<string, IAvailability> {
        const availability: Record<string, IAvailability> = {};
        const results = movie["watch/providers"]?.results ?? {};

        for (const country of this.deps.countries) {
            const flatrate = results[country]?.flatrate ?? [];

            if (flatrate.length === 0) {
                continue;
            }

            availability[country] = {
                services: [...new Set(flatrate.map((ref: TmdbProviderRef) => slugify(ref.provider_name)))],
                links: results[country]?.link ? { tmdb: results[country].link as string } : undefined,
                checkedAt,
            };
        }

        return availability;
    }

    private ratingsFor(movie: TmdbMovieDetails): Record<string, string> | undefined {
        const ratings: Record<string, string> = {};

        for (const country of this.deps.countries) {
            const dates = movie.release_dates?.results.find(entry => entry.iso_3166_1 === country)?.release_dates ?? [];
            const certification = (dates.find(date => date.type === 3 && date.certification) ?? dates.find(date => date.certification))?.certification;

            if (certification) {
                ratings[country] = certification;
            }
        }

        return Object.keys(ratings).length > 0 ? ratings : undefined;
    }

    private async storeImage(path: string | null, size: string, key: string): Promise<string | undefined> {
        if (!path) {
            return undefined;
        }

        try {
            return await this.deps.assetStore.ensureFromUrl(this.deps.tmdb.imageUrl(path, size), key);
        } catch (error: any) {
            console.error(`Could not store image ${key}: ${error.message}`);
            return undefined;
        }
    }
}

export function movieIdFor(tmdbId: number): string {
    return `tmdb:${tmdbId}`;
}

export function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function yearOf(movie: TmdbMovieDetails): number | undefined {
    const year = Number(movie.release_date?.slice(0, 4));
    return Number.isFinite(year) && year > 0 ? year : undefined;
}

function genreNames(movie: TmdbMovieDetails): string[] {
    return movie.genres.map(genre => genre.name.toLowerCase());
}

/** The text whose embedding represents the film: its mood description plus genres and keywords. */
export function embeddingTextFor(item: Omit<IMovie, "why">, movie: TmdbMovieDetails): string {
    const keywords = movie.keywords?.keywords.slice(0, 10).map(keyword => keyword.name) ?? [];
    const parts = [item.moodDesc ?? ""];

    if (item.genres?.length) parts.push(`Genres: ${item.genres.join(", ")}.`);
    if (keywords.length) parts.push(`Themes: ${keywords.join(", ")}.`);

    return parts.join(" ");
}

/**
 * Filterable metadata stored with the vector; see S3VectorsCandidateRetrieverImpl for the reader.
 * S3 Vectors rejects empty arrays, so list fields are only written when they have values. A film
 * with no known certification therefore has no `ratings` key and is excluded by rating filters
 * until the rating constraint is relaxed.
 */
export function vectorMetadataFor(item: Omit<IMovie, "why">, countries: string[]): VectorMetadata {
    const metadata: VectorMetadata = {
        movieId: item.movieId,
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
