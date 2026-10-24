import { CandidateRetriever } from "../src/services/recommendations/CandidateRetriever";
import { Embedder } from "../src/services/recommendations/Embedder";
import { ExplanationService } from "../src/services/recommendations/ExplanationService";
import { MoodResolver } from "../src/services/recommendations/MoodResolver";
import { RecommendationServiceImpl, relaxationStages } from "../src/services/recommendations/RecommendationServiceImpl";
import { RequestRepository } from "../src/services/recommendations/RequestRepository";
import {
    EObjective,
    ICandidate,
    IMoodProfile,
    IRecommendationRequest,
    IRetrievalFilters,
} from "../src/services/recommendations/domain/types";
import { rerank, selectDiverse } from "../src/services/recommendations/ranking";
import { applyObjective, renderTargetSentence } from "../src/services/recommendations/targeting";
import { RateLimitError, SafetyError, ValidationError } from "../src/services/common/errors";
import { ICatalogItem, IWhyEntry } from "../src/services/catalog/domain/items";
import { CatalogItemRepository } from "../src/services/catalog/store/CatalogItemRepository";
import { EMediaType } from "../src/services/media/MediaType";
import { UserRepository } from "../src/services/users/UserRepository";
import { EIdentityProvider, EVote, IUser } from "../src/services/users/domain/types";
import { EPlan } from "../src/services/billing/domain/types";
import { DailyCaps, nextUtcMidnight } from "../src/services/billing/plans";

const drained: IMoodProfile = {
    primary_emotion: "drained",
    valence: -0.4,
    arousal: -0.6,
    themes_seek: ["warmth", "humour", "friendship"],
    themes_avoid: ["violence", "grief"],
    constraints: { max_runtime_min: 120 },
    confidence: 0.82,
    safety_flag: false,
};

describe("applyObjective", () => {
    test("improve lifts valence, calms arousal toward neutral and adds uplift (spec example)", () => {
        expect(applyObjective(drained, EObjective.IMPROVE)).toEqual({
            valence: 0.1,
            arousal: -0.4,
            themes_seek: ["warmth", "humour", "friendship", "uplift"],
        });
    });

    test("keep copies the mood vector unchanged", () => {
        expect(applyObjective(drained, EObjective.KEEP)).toEqual({
            valence: -0.4,
            arousal: -0.6,
            themes_seek: ["warmth", "humour", "friendship"],
        });
    });

    test("improve never pushes valence above one", () => {
        expect(applyObjective({ ...drained, valence: 0.8 }, EObjective.IMPROVE).valence).toBe(1);
    });

    test("renders a sentence that names the target feel, themes sought and themes avoided", () => {
        const sentence = renderTargetSentence(applyObjective(drained, EObjective.IMPROVE), drained);

        expect(sentence).toBe(
            "A film that feels gently positive and calm, with warmth, humour, friendship and uplift, avoiding violence and grief.",
        );
    });
});

function candidate(itemId: string, overrides: Partial<ICandidate> = {}): ICandidate {
    return { itemId, mediaType: EMediaType.MOVIE, similarity: 0.5, popularity: 100, year: 2020, primaryGenre: "comedy", genres: ["comedy"], ...overrides };
}

describe("rerank and selectDiverse", () => {
    test("removes thumbed-down titles and boosts thumbed-up ones", () => {
        const ranked = rerank(
            [candidate("a"), candidate("b"), candidate("c")],
            { genrePrefs: {}, votes: { a: { vote: EVote.DOWN, requestId: "r", at: "t" }, c: { vote: EVote.UP, requestId: "r", at: "t" } } },
        );

        expect(ranked.map(item => item.itemId)).toEqual(["c", "b"]);
    });

    test("prefers higher similarity when everything else is equal", () => {
        const ranked = rerank([candidate("low", { similarity: 0.2 }), candidate("high", { similarity: 0.9 })], { genrePrefs: {}, votes: {} });

        expect(ranked[0].itemId).toBe("high");
    });

    test("genre preferences lift matching titles", () => {
        const ranked = rerank(
            [candidate("drama", { primaryGenre: "drama", genres: ["drama"] }), candidate("comedy")],
            { genrePrefs: { drama: 1, comedy: 0 }, votes: {} },
        );

        expect(ranked[0].itemId).toBe("drama");
    });

    test("leaves out titles the user has already watched", () => {
        const ranked = rerank([candidate("seen"), candidate("new")], { genrePrefs: {}, votes: {}, watched: ["seen"] });

        expect(ranked.map(item => item.itemId)).toEqual(["new"]);
    });

    test("limits how many titles share a primary genre", () => {
        const ranked = rerank(
            ["c1", "c2", "c3", "d1", "d2", "d3"].map(id =>
                candidate(id, { primaryGenre: id.startsWith("c") ? "comedy" : "drama", genres: [id.startsWith("c") ? "comedy" : "drama"], similarity: id.startsWith("c") ? 0.9 : 0.5 })),
            { genrePrefs: {}, votes: {} },
        );

        const chosen = selectDiverse(ranked, 4, 2);

        expect(chosen.map(item => item.itemId)).toEqual(["c1", "c2", "d1", "d2"]);
    });
});

describe("relaxationStages", () => {
    const filters: IRetrievalFilters = { mediaTypes: [EMediaType.MOVIE], country: "ZA", services: ["netflix"], ratingsAllowed: ["PG"], maxRuntimeMin: 120 };

    test("drops runtime first, then rating", () => {
        expect(relaxationStages(filters)).toEqual([
            filters,
            { ...filters, maxRuntimeMin: undefined },
            { ...filters, maxRuntimeMin: undefined, ratingsAllowed: [] },
        ]);
    });

    test("has nothing to relax when no constraints are set", () => {
        expect(relaxationStages({ mediaTypes: [EMediaType.MOVIE], country: "ZA", services: [], ratingsAllowed: [] })).toHaveLength(1);
    });
});

class FakeUserRepository implements UserRepository {
    public reservations: { userId: string; today: string; cap: number }[] = [];
    public releases: { userId: string; today: string }[] = [];
    /** Simulates another request taking the last slot between the profile read and the reservation. */
    public full = false;

    constructor(public user: IUser | null) {}

    async create(): Promise<void> {}

    async findById(): Promise<IUser | null> {
        return this.user;
    }

    async update(): Promise<IUser> {
        throw new Error("update is not exercised by the recommendation tests");
    }

    async reserveDailyRequest(userId: string, today: string, cap: number): Promise<number | null> {
        this.reservations.push({ userId, today, cap });

        if (!this.user || this.full) return null;

        const used = this.user.dailyCountDate === today ? this.user.dailyCount : 0;

        if (used >= cap) return null;

        this.user = { ...this.user, dailyCount: used + 1, dailyCountDate: today };
        return used + 1;
    }

    async releaseDailyRequest(userId: string, today: string): Promise<void> {
        this.releases.push({ userId, today });

        if (this.user?.dailyCountDate === today) {
            this.user = { ...this.user, dailyCount: Math.max(0, this.user.dailyCount - 1) };
        }
    }

    async setPlan(): Promise<IUser> {
        throw new Error("setPlan is not exercised by the recommendation tests");
    }
}

class FakeMoodResolver implements MoodResolver {
    public readonly name = "fake";
    public texts: string[] = [];

    constructor(private readonly profile: IMoodProfile) {}

    async resolve(text: string): Promise<IMoodProfile> {
        this.texts.push(text);
        return this.profile;
    }
}

class FakeEmbedder implements Embedder {
    public sentences: string[] = [];

    async embed(text: string): Promise<number[]> {
        this.sentences.push(text);
        return [0.1, 0.2, 0.3];
    }
}

class FakeRetriever implements CandidateRetriever {
    public calls: IRetrievalFilters[] = [];
    /** When set, every retrieval fails with this error. */
    public failWith?: Error;

    constructor(private readonly perStage: ICandidate[][]) {}

    async retrieve(_vector: number[], filters: IRetrievalFilters): Promise<ICandidate[]> {
        this.calls.push(filters);

        if (this.failWith) throw this.failWith;

        return this.perStage[Math.min(this.calls.length - 1, this.perStage.length - 1)] ?? [];
    }
}

class FakeCatalogStore implements CatalogItemRepository {
    public savedWhy: { itemId: string; key: string; entry: IWhyEntry }[] = [];

    constructor(private readonly details: Record<string, Record<string, unknown>> = {}) {}

    async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        return itemIds.map(itemId => ({
            itemId,
            mediaType: EMediaType.MOVIE,
            title: `Title ${itemId}`,
            genres: ["comedy"],
            rating: { ZA: "13" },
            availability: { ZA: { services: ["netflix"], checkedAt: "2026-10-01T00:00:00Z" } },
            details: this.details[itemId],
        }));
    }

    async saveWhy(itemId: string, key: string, entry: IWhyEntry): Promise<void> {
        this.savedWhy.push({ itemId, key, entry });
    }

    async upsertCatalog(): Promise<void> {}
}

class FakeExplanationService implements ExplanationService {
    async explain(items: ICatalogItem[]): Promise<Map<string, string>> {
        return new Map(items.map(item => [item.itemId, `Because ${item.title}`]));
    }
}

class FakeRequestRepository implements RequestRepository {
    public saved: IRecommendationRequest[] = [];

    async save(request: IRecommendationRequest): Promise<void> {
        this.saved.push(request);
    }
}

const profile: IUser = {
    userId: "sub-1",
    email: "jane@example.com",
    provider: EIdentityProvider.COGNITO,
    country: "za",
    services: ["netflix"],
    ratingsAllowed: ["PG", "PG-13"],
    genrePrefs: { comedy: 0.9 },
    votes: {},
    createdAt: "2026-09-01T00:00:00Z",
    dailyCount: 0,
    fullyOnboarded: true,
};

function manyCandidates(count: number, prefix = "m"): ICandidate[] {
    return Array.from({ length: count }, (_, index) =>
        candidate(`${prefix}${index}`, { primaryGenre: `genre${index}`, genres: [`genre${index}`], similarity: 1 - index / 100 }));
}

function build(overrides: {
    user?: IUser | null;
    mood?: IMoodProfile;
    stages?: ICandidate[][];
    dailyCaps?: DailyCaps;
    details?: Record<string, Record<string, unknown>>;
} = {}) {
    const userRepository = new FakeUserRepository(overrides.user === undefined ? profile : overrides.user);
    const embedder = new FakeEmbedder();
    const retriever = new FakeRetriever(overrides.stages ?? [manyCandidates(40)]);
    const catalogStore = new FakeCatalogStore(overrides.details);
    const requestRepository = new FakeRequestRepository();
    const moodResolver = new FakeMoodResolver(overrides.mood ?? drained);
    const service = new RecommendationServiceImpl({
        userRepository,
        moodResolver,
        embedder,
        candidateRetriever: retriever,
        catalogStore,
        explanationService: new FakeExplanationService(),
        requestRepository,
        dailyCaps: overrides.dailyCaps ?? { [EPlan.FREE]: 2, [EPlan.ADVANCED]: 15 },
    });

    return { service, userRepository, embedder, retriever, catalogStore, requestRepository, moodResolver };
}

describe("RecommendationServiceImpl.recommend", () => {
    test("runs the text path and persists the request", async () => {
        const { service, retriever, requestRepository, userRepository, embedder } = build();

        const result = await service.recommend({ userId: "sub-1", text: "rough week, I'm flat and tired", objective: EObjective.IMPROVE });

        expect(result.results).toHaveLength(8);
        expect(result.notice).toBeUndefined();
        expect(result.target).toEqual({ valence: 0.1, arousal: -0.4, themes_seek: ["warmth", "humour", "friendship", "uplift"] });
        expect(result.results[0]).toMatchObject({ itemId: "m0", mediaType: "movie", title: "Title m0", why: "Because Title m0", availability: { services: ["netflix"] } });
        expect(embedder.sentences[0]).toContain("gently positive");

        expect(retriever.calls).toHaveLength(1);
        expect(retriever.calls[0]).toMatchObject({ mediaTypes: ["movie", "series", "documentary"], country: "ZA", maxRuntimeMin: 120 });
        expect(retriever.calls[0].services).toContain("netflix");
        // The profile's MPAA-style ceiling becomes South Africa's own certifications.
        expect(retriever.calls[0].ratingsAllowed).toEqual(expect.arrayContaining(["PG", "13"]));
        expect(retriever.calls[0].ratingsAllowed).not.toContain("16");
        expect(result.results[0].matchScore).toBeGreaterThan(0);

        expect(requestRepository.saved).toHaveLength(1);
        const saved = requestRepository.saved[0];
        expect(saved).toMatchObject({ userId: "sub-1", inputType: "text", objective: "improve", resolver: "fake", moodProfile: drained });
        expect(saved.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(saved.resultIds).toHaveLength(8);
        expect(saved.ttl - Math.floor(Date.parse(saved.requestedAt) / 1000)).toBe(90 * 24 * 60 * 60);

        // The request slot is taken on the free plan's cap and kept, and the result says where the user stands.
        const today = saved.requestedAt.slice(0, 10);
        expect(userRepository.reservations).toEqual([{ userId: "sub-1", today, cap: 2 }]);
        expect(userRepository.releases).toEqual([]);
        expect(result.usage).toEqual({ plan: "free", used: 1, limit: 2, remaining: 1, resetsAt: nextUtcMidnight(new Date(saved.requestedAt)) });
    });

    test("stops with a safety error and ranks nothing when the mood raises a safety flag", async () => {
        const { service, retriever, requestRepository, userRepository } = build({
            mood: { ...drained, safety_flag: true, supportive_message: "You matter. Please reach out to someone you trust." },
        });

        await expect(service.recommend({ userId: "sub-1", text: "...", objective: EObjective.IMPROVE }))
            .rejects.toThrow("You matter. Please reach out to someone you trust.");
        await expect(service.recommend({ userId: "sub-1", text: "...", objective: EObjective.IMPROVE }))
            .rejects.toBeInstanceOf(SafetyError);

        expect(retriever.calls).toHaveLength(0);
        expect(requestRepository.saved).toHaveLength(0);
        // The slot taken up front is handed back, so a flagged request costs the user nothing.
        expect(userRepository.reservations).toHaveLength(2);
        expect(userRepository.releases).toHaveLength(2);
        expect(userRepository.user?.dailyCount).toBe(0);
    });

    test("caps each plan at its own daily limit, counting today's requests only", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const ask = { userId: "sub-1", text: "tired", objective: EObjective.KEEP };
        const freeAtCap = build({ user: { ...profile, dailyCount: 2, dailyCountDate: today } });

        await expect(freeAtCap.service.recommend(ask)).rejects.toMatchObject({
            name: "RateLimitError",
            statusCode: 429,
            message: "You've used your 2 free requests for today. Upgrade to Advanced for 15 a day, or come back tomorrow.",
            details: { code: "daily_limit_reached", plan: "free", limit: 2, used: 2, resetsAt: expect.stringMatching(/T00:00:00\.000Z$/) },
        });
        // Rejected from the profile alone: no write, no model call.
        expect(freeAtCap.userRepository.reservations).toHaveLength(0);
        expect(freeAtCap.moodResolver.texts).toHaveLength(0);

        const freeYesterday = build({ user: { ...profile, dailyCount: 2, dailyCountDate: "2000-01-01" } });

        await expect(freeYesterday.service.recommend(ask)).resolves.toMatchObject({ usage: { plan: "free", used: 1, limit: 2, remaining: 1 } });

        const advanced: IUser = { ...profile, plan: EPlan.ADVANCED, planExpiresAt: "2999-01-01T00:00:00.000Z", dailyCount: 2, dailyCountDate: today };

        await expect(build({ user: advanced }).service.recommend(ask)).resolves.toMatchObject({ usage: { plan: "advanced", used: 3, limit: 15, remaining: 12 } });
        await expect(build({ user: { ...advanced, dailyCount: 15 } }).service.recommend(ask)).rejects.toMatchObject({
            message: "You've used all 15 requests for today. Come back tomorrow.",
            details: { plan: "advanced", limit: 15 },
        });

        // A lapsed subscription is capped like a free one.
        await expect(build({ user: { ...advanced, planExpiresAt: "2000-01-01T00:00:00.000Z" } }).service.recommend(ask))
            .rejects.toBeInstanceOf(RateLimitError);
    });

    test("takes the caps from its dependencies", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const custom = build({ user: { ...profile, dailyCount: 4, dailyCountDate: today }, dailyCaps: { [EPlan.FREE]: 5, [EPlan.ADVANCED]: 50 } });

        await expect(custom.service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP }))
            .resolves.toMatchObject({ usage: { plan: "free", used: 5, limit: 5, remaining: 0 } });
    });

    test("stops when the counter turns out full at reservation time, even if the profile read looked under the cap", async () => {
        const { service, userRepository, moodResolver } = build();
        userRepository.full = true;

        await expect(service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP }))
            .rejects.toBeInstanceOf(RateLimitError);
        expect(userRepository.reservations).toHaveLength(1);
        expect(userRepository.releases).toHaveLength(0);
        expect(moodResolver.texts).toHaveLength(0);
    });

    test("gives the slot back when the pipeline fails", async () => {
        const { service, userRepository, retriever } = build();
        retriever.failWith = new Error("vector index unavailable");

        await expect(service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP }))
            .rejects.toThrow("vector index unavailable");
        expect(userRepository.reservations).toHaveLength(1);
        expect(userRepository.releases).toEqual([{ userId: "sub-1", today: new Date().toISOString().slice(0, 10) }]);
        expect(userRepository.user?.dailyCount).toBe(0);
    });

    test("requires a country before it can filter availability", async () => {
        const { service } = build({ user: { ...profile, country: undefined } });

        await expect(service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP }))
            .rejects.toBeInstanceOf(ValidationError);
    });

    test("prefers country and services carried in the JWT over the profile", async () => {
        const { service, retriever } = build();

        await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP, country: "us", services: ["hulu"] });

        expect(retriever.calls[0]).toMatchObject({ country: "US", services: ["hulu"] });
    });

    test("narrows retrieval to the media types the caller asked for", async () => {
        const { service, retriever } = build();

        await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP, mediaTypes: [EMediaType.DOCUMENTARY] });

        expect(retriever.calls[0].mediaTypes).toEqual(["documentary"]);
    });

    test("relaxes runtime, then rating, when too few titles survive", async () => {
        const { service, retriever } = build({ stages: [manyCandidates(3, "a"), manyCandidates(2, "b"), manyCandidates(40, "c")] });

        const result = await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.IMPROVE });

        expect(retriever.calls.map(call => [call.maxRuntimeMin, call.ratingsAllowed.length > 0])).toEqual([
            [120, true],
            [undefined, true],
            [undefined, false],
        ]);
        expect(result.results).toHaveLength(8);
        expect(result.notice).toBeUndefined();
    });

    test("returns what it has with a few-matches notice when relaxing is not enough", async () => {
        const { service } = build({ stages: [manyCandidates(2, "a"), manyCandidates(2, "a"), manyCandidates(3, "a")] });

        const result = await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.IMPROVE });

        expect(result.results).toHaveLength(3);
        expect(result.notice).toBe("few_matches");
    });

    test("hands the ticked moods to the mood resolver and keeps them on the request", async () => {
        const { service, moodResolver, requestRepository } = build();

        await service.recommend({ userId: "sub-1", text: "long day", objective: EObjective.KEEP, moods: ["tired", "stressed"] });

        expect(moodResolver.texts[0]).toBe("long day\nMoods I selected: tired, stressed");
        expect(requestRepository.saved[0]).toMatchObject({ text: "long day", moods: ["tired", "stressed"] });
    });

    test("turns the app's filters into retrieval constraints, using the tighter runtime", async () => {
        const { service, retriever, requestRepository } = build();
        const filters = { maxRuntimeMin: 90, genres: ["science-fiction", "comedy"], releaseYearMin: 2010 };

        await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP, filters });

        expect(retriever.calls[0]).toMatchObject({
            maxRuntimeMin: 90,
            genres: ["science fiction", "sci-fi & fantasy", "comedy"],
            minYear: 2010,
        });
        expect(requestRepository.saved[0].filters).toEqual(filters);
    });

    test("drops titles below the asked-for score or in another language, but keeps ones with no data", async () => {
        const { service } = build({
            stages: [manyCandidates(10)],
            details: {
                m0: { voteAverage: 5.1, originalLanguage: "en" },
                m1: { voteAverage: 8.2, originalLanguage: "fr" },
                m2: { voteAverage: 8.2, originalLanguage: "en" },
            },
        });

        const result = await service.recommend({
            userId: "sub-1",
            text: "tired",
            objective: EObjective.KEEP,
            filters: { minRating: 7, language: "en" },
        });
        const ids = result.results.map(item => item.itemId);

        expect(ids).not.toContain("m0");
        expect(ids).not.toContain("m1");
        expect(ids).toContain("m2");
        expect(ids).toContain("m3");
    });

    test("returns the content rating for the user's country on each result", async () => {
        const { service } = build();

        const result = await service.recommend({ userId: "sub-1", text: "tired", objective: EObjective.KEEP });

        expect(result.results[0].rating).toBe("13");
    });
});
