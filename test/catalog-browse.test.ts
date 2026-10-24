import { CatalogScanner } from "../src/services/catalog/CatalogScanner";
import { CatalogBrowseServiceImpl, searchScore } from "../src/services/catalog/CatalogBrowseServiceImpl";
import { ICatalogItem } from "../src/services/catalog/domain/items";
import { CatalogItemRepository } from "../src/services/catalog/store/CatalogItemRepository";
import { NotFoundError, ValidationError } from "../src/services/common/errors";
import { EMediaType } from "../src/services/media/MediaType";
import { UserRepository } from "../src/services/users/UserRepository";
import { EIdentityProvider, IUser } from "../src/services/users/domain/types";

const checkedAt = "2026-10-01T00:00:00Z";

function item(id: string, overrides: Partial<ICatalogItem> = {}): ICatalogItem {
    return {
        itemId: `movie:tmdb-movie:${id}`,
        mediaType: EMediaType.MOVIE,
        title: `Film ${id}`,
        genres: ["comedy"],
        popularity: 50,
        rating: { ZA: "13", US: "PG-13" },
        availability: { ZA: { services: ["netflix"], checkedAt }, US: { services: ["amazon-prime-video"], checkedAt } },
        ...overrides,
    };
}

const catalogue: ICatalogItem[] = [
    item("1", { title: "The Matrix", popularity: 90, genres: ["science fiction", "action"], details: { kind: "film", director: "Lana Wachowski", cast: [{ name: "Keanu Reeves" }], voteAverage: 8.2, voteCount: 20000 } }),
    item("2", { title: "Matrix Reloaded", popularity: 70, details: { kind: "film", voteAverage: 7.0, voteCount: 9000 } }),
    item("3", { title: "John Wick", popularity: 80, genres: ["action"], details: { kind: "film", cast: [{ name: "Keanu Reeves" }], voteAverage: 7.4, voteCount: 12000 } }),
    item("4", { title: "Hidden Gem", popularity: 10, availability: { US: { services: ["max"], checkedAt } }, details: { kind: "film", voteAverage: 9.0, voteCount: 12 } }),
    item("5", { title: "Planet Earth", mediaType: EMediaType.DOCUMENTARY, itemId: "documentary:tmdb-tv:5", popularity: 60, genres: ["documentary"], details: { kind: "show", voteAverage: 8.9, voteCount: 5000 } }),
];

class FakeScanner implements CatalogScanner {
    public scans = 0;

    async scanVideo(): Promise<ICatalogItem[]> {
        this.scans += 1;
        return catalogue;
    }
}

class FakeStore implements CatalogItemRepository {
    async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        return catalogue.filter(entry => itemIds.includes(entry.itemId)).reverse();
    }

    async saveWhy(): Promise<void> {}

    async upsertCatalog(): Promise<void> {}
}

class FakeUsers implements UserRepository {
    constructor(private readonly country: string | undefined = "ZA") {}

    async create(): Promise<void> {}

    async findById(userId: string): Promise<IUser | null> {
        return {
            userId,
            email: "a@b.c",
            provider: EIdentityProvider.COGNITO,
            country: this.country,
            services: [],
            ratingsAllowed: [],
            genrePrefs: {},
            votes: {},
            createdAt: checkedAt,
            dailyCount: 0,
            fullyOnboarded: true,
        };
    }

    async update(): Promise<IUser> {
        throw new Error("not used");
    }

    async incrementDailyCount(): Promise<number> {
        return 0;
    }
}

function build(country?: string) {
    const scanner = new FakeScanner();
    let clock = 0;
    const service = new CatalogBrowseServiceImpl(scanner, new FakeStore(), new FakeUsers(country), () => clock);

    return { service, scanner, advance: (ms: number) => { clock += ms; } };
}

describe("searchScore", () => {
    test("ranks titles above people above genres", () => {
        const matrix = catalogue[0];

        expect(searchScore(matrix, "the matrix")).toBe(100);
        expect(searchScore(matrix, "the")).toBe(80);
        expect(searchScore(matrix, "matrix")).toBe(60);
        expect(searchScore(matrix, "keanu")).toBe(40);
        expect(searchScore(matrix, "science fiction")).toBe(20);
        expect(searchScore(matrix, "casablanca")).toBe(0);
    });
});

describe("CatalogBrowseServiceImpl.search", () => {
    test("lists title matches first, then people, only for titles streaming in the user's country", async () => {
        const { service } = build("ZA");

        const results = await service.search("u1", { query: "matrix" });

        expect(results.map(result => result.title)).toEqual(["Matrix Reloaded", "The Matrix"]);

        const byActor = await service.search("u1", { query: "keanu" });

        expect(byActor.map(result => result.title)).toEqual(["The Matrix", "John Wick"]);
    });

    test("narrows availability and rating to the requested country", async () => {
        const { service } = build("ZA");

        const [us] = await service.search("u1", { query: "the matrix" }, "us");

        expect(us.availability?.services).toEqual(["amazon-prime-video"]);
        expect(us.rating).toBe("PG-13");
    });

    test("filters by media type and ignores a blank query", async () => {
        const { service } = build("ZA");

        expect(await service.search("u1", { query: "  " })).toEqual([]);
        expect((await service.search("u1", { query: "planet", mediaTypes: [EMediaType.MOVIE] }))).toEqual([]);
    });

    test("reuses one catalogue scan until the cache expires", async () => {
        const { service, scanner, advance } = build("ZA");

        await service.search("u1", { query: "matrix" });
        await service.popular("u1", {});
        expect(scanner.scans).toBe(1);

        advance(6 * 60 * 1000);
        await service.search("u1", { query: "matrix" });
        expect(scanner.scans).toBe(2);
    });
});

describe("CatalogBrowseServiceImpl.popular", () => {
    test("orders by popularity among titles streaming in the country", async () => {
        const { service } = build("ZA");

        const results = await service.popular("u1", { limit: 2 });

        expect(results.map(result => result.title)).toEqual(["The Matrix", "John Wick"]);
    });

    test("can be limited to the user's own services, given in the app's vocabulary", async () => {
        const { service } = build("US");

        const results = await service.popular("u1", { services: ["prime"] });

        expect(results.every(result => result.availability?.services.includes("amazon-prime-video"))).toBe(true);
        expect(results.map(result => result.title)).not.toContain("Hidden Gem");
    });

    test("ranks by audience score, ignoring titles with too few votes", async () => {
        const { service } = build("US");

        const results = await service.popular("u1", { sort: "rating" });

        expect(results.map(result => result.title)).toEqual(["Planet Earth", "The Matrix", "John Wick", "Matrix Reloaded"]);
        expect(results.map(result => result.title)).not.toContain("Hidden Gem");
    });
});

describe("CatalogBrowseServiceImpl.get and getMany", () => {
    test("returns items in the order asked for", async () => {
        const { service } = build("ZA");

        const results = await service.getMany("u1", ["movie:tmdb-movie:3", "movie:tmdb-movie:1"]);

        expect(results.map(result => result.title)).toEqual(["John Wick", "The Matrix"]);
    });

    test("rejects malformed ids and over-long lists", async () => {
        const { service } = build("ZA");

        await expect(service.getMany("u1", ["nope"])).rejects.toBeInstanceOf(ValidationError);
        await expect(service.getMany("u1", Array.from({ length: 51 }, (_, index) => `movie:tmdb-movie:${index}`))).rejects.toBeInstanceOf(ValidationError);
    });

    test("get throws NotFoundError for an id that is not in the catalogue", async () => {
        const { service } = build("ZA");

        await expect(service.get("u1", "movie:tmdb-movie:999")).rejects.toBeInstanceOf(NotFoundError);
        await expect(service.get("u1", "movie:tmdb-movie:1")).resolves.toMatchObject({ title: "The Matrix", rating: "13" });
    });
});
