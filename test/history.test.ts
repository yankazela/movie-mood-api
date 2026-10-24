import { ulid } from "ulid";
import { HistoryServiceImpl, requestedAtOf } from "../src/services/recommendations/HistoryServiceImpl";
import { IRequestOutcome, RequestHistoryRepository } from "../src/services/recommendations/RequestHistoryRepository";
import { RecordOutcomeRequest } from "../src/services/recommendations/dto/RecordOutcomeRequest";
import { EFeedback, EInputType, EObjective, IMoodProfile, IRecommendationRequest } from "../src/services/recommendations/domain/types";
import { ICatalogItem } from "../src/services/catalog/domain/items";
import { CatalogItemRepository } from "../src/services/catalog/store/CatalogItemRepository";
import { NotFoundError, ValidationError } from "../src/services/common/errors";
import { EMediaType } from "../src/services/media/MediaType";
import { UserRepository } from "../src/services/users/UserRepository";
import { EIdentityProvider, IUser } from "../src/services/users/domain/types";

const mood: IMoodProfile = {
    primary_emotion: "tired",
    valence: -0.2,
    arousal: -0.5,
    themes_seek: ["comfort"],
    themes_avoid: [],
    constraints: {},
    confidence: 0.9,
    safety_flag: false,
};

function request(startedAt: Date, overrides: Partial<IRecommendationRequest> = {}): IRecommendationRequest {
    return {
        userId: "u1",
        requestedAt: startedAt.toISOString(),
        requestId: ulid(startedAt.getTime()),
        inputType: EInputType.TEXT,
        text: "long day",
        objective: EObjective.KEEP,
        moodProfile: mood,
        target: { valence: -0.2, arousal: -0.5, themes_seek: ["comfort"] },
        resultIds: ["movie:tmdb-movie:1", "movie:tmdb-movie:gone", "movie:tmdb-movie:2"],
        resolver: "fake",
        latencyMs: 10,
        ttl: 0,
        ...overrides,
    };
}

class FakeRequests implements RequestHistoryRepository {
    public outcomes: { userId: string; requestedAt: string; outcome: IRequestOutcome }[] = [];
    public limits: number[] = [];

    constructor(private readonly stored: IRecommendationRequest[]) {}

    async listByUser(_userId: string, limit: number): Promise<IRecommendationRequest[]> {
        this.limits.push(limit);
        return this.stored;
    }

    async recordOutcome(userId: string, requestedAt: string, outcome: IRequestOutcome): Promise<IRecommendationRequest> {
        this.outcomes.push({ userId, requestedAt, outcome });
        const found = this.stored.find(entry => entry.requestedAt === requestedAt);
        if (!found) throw new NotFoundError("missing");
        return { ...found, ...outcome };
    }
}

class FakeCatalog implements CatalogItemRepository {
    async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        return itemIds
            .filter(itemId => !itemId.endsWith("gone"))
            .map(itemId => ({
                itemId,
                mediaType: EMediaType.MOVIE,
                title: `Title ${itemId}`,
                availability: { ZA: { services: ["netflix"], checkedAt: "2026-10-01" }, US: { services: ["hulu"], checkedAt: "2026-10-01" } },
            }));
    }

    async saveWhy(): Promise<void> {}

    async upsertCatalog(): Promise<void> {}
}

class FakeUsers implements UserRepository {
    async create(): Promise<void> {}

    async findById(userId: string): Promise<IUser | null> {
        return { userId, email: "a@b.c", provider: EIdentityProvider.COGNITO, country: "ZA", services: [], ratingsAllowed: [], genrePrefs: {}, votes: {}, createdAt: "2026-09-01", dailyCount: 0, fullyOnboarded: true };
    }

    async update(): Promise<IUser> {
        throw new Error("not used");
    }

    async incrementDailyCount(): Promise<number> {
        return 0;
    }
}

describe("HistoryServiceImpl", () => {
    const newer = request(new Date("2026-10-02T10:00:00.000Z"), { moods: ["tired"], selectedItemId: "movie:tmdb-movie:2", feedback: EFeedback.GOOD });
    const older = request(new Date("2026-10-01T10:00:00.000Z"));

    test("lists requests as stored, with their titles hydrated in order and availability for the user's country", async () => {
        const requests = new FakeRequests([newer, older]);
        const service = new HistoryServiceImpl(requests, new FakeCatalog(), new FakeUsers());

        const entries = await service.list("u1");

        expect(entries.map(entry => entry.requestId)).toEqual([newer.requestId, older.requestId]);
        expect(entries[0]).toMatchObject({ text: "long day", moods: ["tired"], selectedItemId: "movie:tmdb-movie:2", feedback: "good" });
        expect(entries[0].results.map(result => result.itemId)).toEqual(["movie:tmdb-movie:1", "movie:tmdb-movie:2"]);
        expect(entries[0].results[0].availability?.services).toEqual(["netflix"]);
    });

    test("keeps the page size between one and the maximum", async () => {
        const requests = new FakeRequests([]);
        const service = new HistoryServiceImpl(requests, new FakeCatalog(), new FakeUsers());

        await service.list("u1");
        await service.list("u1", 1000);
        await service.list("u1", 0);

        expect(requests.limits).toEqual([30, 50, 30]);
    });

    test("records an outcome against the request whose sort key is encoded in its id", async () => {
        const requests = new FakeRequests([newer, older]);
        const service = new HistoryServiceImpl(requests, new FakeCatalog(), new FakeUsers());

        const entry = await service.recordOutcome("u1", older.requestId, { feedback: EFeedback.PERFECT });

        expect(requests.outcomes).toEqual([{ userId: "u1", requestedAt: older.requestedAt, outcome: { feedback: "perfect" } }]);
        expect(entry.feedback).toBe("perfect");
        expect(entry.requestId).toBe(older.requestId);
    });

    test("rejects ids that are not ULIDs", async () => {
        const service = new HistoryServiceImpl(new FakeRequests([]), new FakeCatalog(), new FakeUsers());

        await expect(service.recordOutcome("u1", "not-a-ulid", { feedback: EFeedback.GOOD })).rejects.toBeInstanceOf(ValidationError);
        expect(() => requestedAtOf("short")).toThrow(ValidationError);
    });
});

describe("RecordOutcomeRequest.fromBody", () => {
    test("needs at least one field", async () => {
        await expect(RecordOutcomeRequest.fromBody(JSON.stringify({}))).rejects.toThrow(/selectedItemId or feedback/);
    });

    test("validates the rating and the item id", async () => {
        await expect(RecordOutcomeRequest.fromBody(JSON.stringify({ feedback: "meh" }))).rejects.toBeInstanceOf(ValidationError);
        await expect(RecordOutcomeRequest.fromBody(JSON.stringify({ selectedItemId: "tmdb:1" }))).rejects.toThrow(/not a valid item id/);
    });

    test("accepts a selection and a rating together", async () => {
        const body = await RecordOutcomeRequest.fromBody(JSON.stringify({ selectedItemId: "movie:tmdb-movie:1", feedback: "okay" }));

        expect(body).toMatchObject({ selectedItemId: "movie:tmdb-movie:1", feedback: "okay" });
    });
});
