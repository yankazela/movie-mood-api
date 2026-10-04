import { CatalogRefreshServiceImpl, slugify, vectorMetadataFor } from "../src/services/catalog/CatalogRefreshServiceImpl";
import { IMoodSource, MoodDescriber } from "../src/services/catalog/MoodDescriber";
import { TmdbClient, TmdbDiscoverPage, TmdbMovieDetails, TmdbProviderRef } from "../src/services/catalog/TmdbClient";
import { IProvidersItem } from "../src/services/catalog/domain/types";
import { ConfigRepository } from "../src/services/config/ConfigRepository";
import { IMovie, IWhyEntry } from "../src/services/movies/domain/types";
import { MovieRepository } from "../src/services/movies/MovieRepository";
import { ProviderRepository } from "../src/services/providers/ProviderRepository";
import { Embedder } from "../src/services/recommendations/Embedder";
import { AssetStore } from "../src/services/storage/AssetStore";
import { IVectorMatch, IVectorRecord, VectorIndex } from "../src/services/vectors/VectorIndex";

function details(id: number, overrides: Partial<TmdbMovieDetails> = {}): TmdbMovieDetails {
    return {
        id,
        title: `Movie ${id}`,
        overview: `Overview ${id}`,
        release_date: "2020-05-01",
        runtime: 100,
        genres: [{ id: 35, name: "Comedy" }, { id: 18, name: "Drama" }],
        popularity: 42,
        vote_count: 1000,
        poster_path: `/poster${id}.jpg`,
        keywords: { keywords: [{ name: "friendship" }] },
        release_dates: { results: [{ iso_3166_1: "ZA", release_dates: [{ certification: "13", type: 3 }] }] },
        "watch/providers": { results: { ZA: { link: "https://tmdb/watch", flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png" }] } } },
        ...overrides,
    };
}

class FakeTmdb implements TmdbClient {
    public discoverCalls: { country: string; page: number }[] = [];
    public providerCalls: string[] = [];

    constructor(
        private readonly pages: Record<number, number[]>,
        private readonly totalPages: number,
        private readonly detailOverrides: Record<number, Partial<TmdbMovieDetails>> = {},
        /** Lets a test simulate time passing while a page is fetched. */
        private readonly onDiscover: () => void = () => {},
    ) {}

    async discoverMovies(country: string, page: number): Promise<TmdbDiscoverPage> {
        this.discoverCalls.push({ country, page });
        this.onDiscover();
        return { page, totalPages: this.totalPages, results: (this.pages[page] ?? []).map(id => ({ id, title: `Movie ${id}` })) };
    }

    async getMovie(tmdbId: number): Promise<TmdbMovieDetails> {
        return details(tmdbId, this.detailOverrides[tmdbId]);
    }

    async listProviders(country: string): Promise<TmdbProviderRef[]> {
        this.providerCalls.push(country);
        return [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priority: 1 }, { provider_id: 55, provider_name: "Showmax", logo_path: null, display_priority: 2 }];
    }

    imageUrl(path: string, size: string): string {
        return `https://img/${size}${path}`;
    }
}

class FakeDescriber implements MoodDescriber {
    public asked: string[][] = [];

    async describe(movies: IMoodSource[]): Promise<Map<string, string>> {
        this.asked.push(movies.map(movie => movie.movieId));
        return new Map(movies.map(movie => [movie.movieId, `Feels like ${movie.title}`]));
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

class FakeMovies implements MovieRepository {
    public saved = new Map<string, Omit<IMovie, "why">>();

    constructor(existing: IMovie[] = []) {
        for (const movie of existing) this.saved.set(movie.movieId, movie);
    }

    async findByIds(movieIds: string[]): Promise<IMovie[]> {
        return movieIds.map(id => this.saved.get(id)).filter((movie): movie is IMovie => Boolean(movie));
    }

    async saveWhy(_movieId: string, _key: string, _entry: IWhyEntry): Promise<void> {}

    async upsertCatalog(movie: Omit<IMovie, "why">): Promise<void> {
        this.saved.set(movie.movieId, { ...this.saved.get(movie.movieId), ...movie });
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
    public puts = 0;

    async get(key: string): Promise<Record<string, unknown> | null> {
        return this.items.get(key) ?? null;
    }

    async put(key: string, fields: Record<string, unknown>): Promise<void> {
        this.puts++;
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

function build(tmdb: FakeTmdb, options: { existing?: IMovie[]; countries?: string[]; clock?: () => Date } = {}) {
    const describer = new FakeDescriber();
    const embedder = new FakeEmbedder();
    const index = new FakeIndex();
    const movies = new FakeMovies(options.existing);
    const providers = new FakeProviders();
    const config = new FakeConfig();
    const assets = new FakeAssets();
    const service = new CatalogRefreshServiceImpl({
        tmdb, moodDescriber: describer, embedder, vectorIndex: index, movieRepository: movies,
        providerRepository: providers, configRepository: config, assetStore: assets,
        countries: options.countries ?? ["ZA"], now: options.clock,
    });

    return { service, describer, embedder, index, movies, providers, config, assets };
}

describe("CatalogRefreshServiceImpl.refresh", () => {
    test("walks every page of one country, writes movies, vectors, providers and completes", async () => {
        const tmdb = new FakeTmdb({ 1: [1, 2], 2: [3] }, 2);
        const { service, describer, index, movies, providers, config, assets } = build(tmdb);

        const result = await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 10 });

        expect(result).toMatchObject({ status: "completed", country: "ZA", page: 2, moviesProcessed: 3 });
        expect(tmdb.discoverCalls).toEqual([{ country: "ZA", page: 1 }, { country: "ZA", page: 2 }]);
        expect(tmdb.providerCalls).toEqual(["ZA"]);

        expect(describer.asked).toEqual([["tmdb:1", "tmdb:2"], ["tmdb:3"]]);
        expect(movies.saved.get("tmdb:1")).toMatchObject({
            title: "Movie 1", year: 2020, runtime: 100, genres: ["comedy", "drama"], primaryGenre: "comedy",
            rating: { ZA: "13" }, popularity: 42, voteCount: 1000, posterKey: "posters/tmdb-1.jpg",
            moodDesc: "Feels like Movie 1", availability: { ZA: { services: ["netflix"], links: { tmdb: "https://tmdb/watch" } } },
        });
        expect(movies.saved.get("tmdb:1")?.embeddedAt).toBeDefined();

        expect(index.upserted.map(record => record.key)).toEqual(["tmdb:1", "tmdb:2", "tmdb:3"]);
        expect(index.upserted[0].metadata).toEqual({
            movieId: "tmdb:1", countries: ["ZA"], availableOn: ["ZA:netflix"], ratings: ["ZA:13"],
            popularity: 42, genres: ["comedy", "drama"], runtime: 100, year: 2020, primaryGenre: "comedy",
        });

        expect(providers.saved).toHaveLength(1);
        expect(providers.saved[0].providers).toEqual([
            { id: 8, slug: "netflix", name: "Netflix", logoKey: "providers/8.jpg", deepLinkTemplate: "https://www.netflix.com/search?q={title}" },
            { id: 55, slug: "showmax", name: "Showmax", logoKey: undefined, deepLinkTemplate: "https://www.showmax.com/eng/search?q={title}" },
        ]);
        expect(assets.stored.map(asset => asset.key)).toEqual(expect.arrayContaining(["providers/8.jpg", "posters/tmdb-1.jpg"]));

        const cursor = config.items.get("CATALOG_CURSOR");
        expect(cursor).toMatchObject({ country: "ZA", page: 2 });
        expect(cursor?.completedAt).toBeDefined();
    });

    test("reuses stored mood descriptions and removes titles that are no longer streamable", async () => {
        const tmdb = new FakeTmdb({ 1: [1, 2] }, 1, { 2: { "watch/providers": { results: {} } } });
        const existing: IMovie = { movieId: "tmdb:1", title: "Movie 1", moodDesc: "Cached feel", embeddedAt: "2026-09-01T00:00:00Z" };
        const { service, describer, index, movies } = build(tmdb, { existing: [existing] });

        await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 10 });

        expect(describer.asked).toEqual([["tmdb:2"]]);
        expect(movies.saved.get("tmdb:1")?.moodDesc).toBe("Cached feel");
        expect(index.upserted.map(record => record.key)).toEqual(["tmdb:1"]);
        expect(index.deleted).toEqual(["tmdb:2"]);
        expect(movies.saved.get("tmdb:2")?.availability).toEqual({});
    });

    test("pauses when the time budget is exhausted and resumes from the saved cursor", async () => {
        // Each page fetch "takes" 40 seconds; the clock is otherwise still.
        let elapsed = 0;
        const clock = () => new Date(1_000_000 + elapsed);
        const tmdb = new FakeTmdb({ 1: [1], 2: [2], 3: [3] }, 3, {}, () => { elapsed += 40_000; });
        const { service, config } = build(tmdb, { clock });

        const paused = await service.refresh({ timeBudgetMs: 45_000, maxPagesPerCountry: 10 });

        expect(paused.status).toBe("paused");
        expect(config.items.get("CATALOG_CURSOR")).toMatchObject({ runId: paused.runId });
        expect(config.items.get("CATALOG_CURSOR")?.completedAt).toBeUndefined();
        // Two pages fit in the budget (0s and 40s checks pass, 80s fails), so the cursor points at page 3.
        expect(config.items.get("CATALOG_CURSOR")?.page).toBe(3);

        const resumed = await service.refresh({ timeBudgetMs: 600_000, maxPagesPerCountry: 10 });

        expect(resumed.status).toBe("completed");
        expect(resumed.runId).toBe(paused.runId);
        expect(tmdb.discoverCalls.filter(call => call.page === 1)).toHaveLength(1);
    });

    test("moves on to the next country and caps pages per country", async () => {
        const tmdb = new FakeTmdb({ 1: [1], 2: [2], 3: [3] }, 500);
        const { service, providers } = build(tmdb, { countries: ["ZA", "US"] });

        const result = await service.refresh({ timeBudgetMs: 60_000, maxPagesPerCountry: 2 });

        expect(result).toMatchObject({ status: "completed", country: "US", page: 2 });
        expect(tmdb.discoverCalls).toEqual([
            { country: "ZA", page: 1 }, { country: "ZA", page: 2 }, { country: "US", page: 1 }, { country: "US", page: 2 },
        ]);
        expect(providers.saved.map(item => item.country)).toEqual(["ZA", "US"]);
    });
});

describe("helpers", () => {
    test("slugify produces the identifiers users put in their services list", () => {
        expect(slugify("Amazon Prime Video")).toBe("amazon-prime-video");
        expect(slugify("Disney Plus")).toBe("disney-plus");
        expect(slugify("Apple TV+")).toBe("apple-tv");
    });

    test("vector metadata never contains empty lists, which S3 Vectors rejects", () => {
        const metadata = vectorMetadataFor({ movieId: "tmdb:9", title: "X", availability: { US: { services: ["hulu"], checkedAt: "t" } } }, ["US"]);

        expect(metadata).toEqual({ movieId: "tmdb:9", countries: ["US"], availableOn: ["US:hulu"], popularity: 0 });
        expect(Object.values(metadata).some(value => Array.isArray(value) && value.length === 0)).toBe(false);
    });
});
