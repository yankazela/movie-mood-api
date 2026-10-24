import { AuthService } from "../src/services/auth/AuthService";
import { NotFoundError, ProfileAlreadyExistsError, ValidationError } from "../src/services/common/errors";
import { ISignInResult } from "../src/services/auth/domain/types";
import { EIdentityProvider, EVote, IIdentity, IUser, IVote } from "../src/services/users/domain/types";
import { UpdateUserRequest } from "../src/services/users/dto/UpdateUserRequest";
import { isFullyOnboarded } from "../src/services/users/onboarding";
import { CreateUserRequest } from "../src/services/users/dto/CreateUserRequest";
import { UserFieldChanges, UserMapChanges, UserRepository } from "../src/services/users/UserRepository";
import { UserServiceImpl } from "../src/services/users/UserServiceImpl";
import { CatalogItemRepository } from "../src/services/catalog/store/CatalogItemRepository";
import { ICatalogItem } from "../src/services/catalog/domain/items";
import { EFeedback } from "../src/services/recommendations/domain/types";
import { EMediaType } from "../src/services/media/MediaType";
import { EPlan, EPlanSource, IEntitlement } from "../src/services/billing/domain/types";

class FakeAuthService implements AuthService {
    public created: { email: string; fullName: string; password?: string }[] = [];
    public deleted: string[] = [];

    async createUser(email: string, fullName: string, password?: string): Promise<IIdentity> {
        this.created.push({ email, fullName, password });
        return { userId: "sub-123", username: "cognito-generated-name", email, provider: EIdentityProvider.COGNITO };
    }

    async deleteUser(username: string): Promise<void> {
        this.deleted.push(username);
    }

    public renamed: { username: string; fullName: string }[] = [];

    async updateName(username: string, fullName: string): Promise<void> {
        this.renamed.push({ username, fullName });
    }

    async signIn(): Promise<ISignInResult> {
        throw new Error("signIn is not exercised by the user service tests");
    }

    async completeNewPassword(): Promise<ISignInResult> {
        throw new Error("completeNewPassword is not exercised by the user service tests");
    }
}

class FakeUserRepository implements UserRepository {
    public saved: IUser[] = [];
    public failWith?: Error;

    async create(user: IUser): Promise<void> {
        if (this.failWith) {
            throw this.failWith;
        }
        if (this.saved.some(existing => existing.userId === user.userId)) {
            throw new ProfileAlreadyExistsError(user.userId);
        }
        this.saved.push(user);
    }

    async findById(userId: string): Promise<IUser | null> {
        return this.saved.find(user => user.userId === userId) ?? null;
    }

    async update(userId: string, changes: UserFieldChanges, votes: Record<string, IVote>, mapChanges: UserMapChanges = {}): Promise<IUser> {
        const current = this.saved.find(user => user.userId === userId);
        if (!current) throw new NotFoundError("missing");
        const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
        const remainingVotes = Object.fromEntries(Object.entries(current.votes).filter(([itemId]) => !(mapChanges.removeVotes ?? []).includes(itemId)));
        Object.assign(current, defined, {
            votes: { ...remainingVotes, ...votes },
            ratings: { ...(current.ratings ?? {}), ...(mapChanges.ratings ?? {}) },
        });
        return current;
    }

    async reserveDailyRequest(): Promise<number | null> {
        throw new Error("reserveDailyRequest is not exercised by the user service tests");
    }

    async releaseDailyRequest(): Promise<void> {
        throw new Error("releaseDailyRequest is not exercised by the user service tests");
    }

    public planChanges: { userId: string; entitlement: IEntitlement; syncedAt: string }[] = [];

    async setPlan(userId: string, entitlement: IEntitlement, syncedAt: string): Promise<IUser> {
        const current = this.saved.find(user => user.userId === userId);
        if (!current) throw new NotFoundError("missing");
        this.planChanges.push({ userId, entitlement, syncedAt });
        delete current.planExpiresAt;
        delete current.planSource;
        delete current.planWillRenew;
        delete current.planProductId;
        Object.assign(current, {
            plan: entitlement.plan,
            planExpiresAt: entitlement.expiresAt,
            planSource: entitlement.source,
            planWillRenew: entitlement.willRenew,
            planProductId: entitlement.productId,
            planUpdatedAt: syncedAt,
        });
        return current;
    }
}

class FakeCatalogStore implements CatalogItemRepository {
    public requested: string[][] = [];

    constructor(private readonly items: ICatalogItem[] = []) {}

    async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        this.requested.push(itemIds);
        // Reversed so the tests catch a service that relies on the store's order.
        return this.items.filter(item => itemIds.includes(item.itemId)).reverse();
    }

    async saveWhy(): Promise<void> {
        throw new Error("saveWhy is not exercised by the user service tests");
    }

    async upsertCatalog(): Promise<void> {
        throw new Error("upsertCatalog is not exercised by the user service tests");
    }
}

describe("UserServiceImpl.createUser (email/password)", () => {
    test("creates the identity, then saves a profile keyed by the Cognito sub", async () => {
        const auth = new FakeAuthService();
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(auth, repository);

        const user = await service.createUser({
            email: "  Jane@Example.com ",
            fullName: " Jane Doe ",
            country: "za",
            password: "Str0ng!Password",
            services: ["netflix"],
        });

        expect(auth.created).toEqual([{ email: "jane@example.com", fullName: "Jane Doe", password: "Str0ng!Password" }]);
        expect(user.fullName).toBe("Jane Doe");
        expect(repository.saved).toHaveLength(1);
        expect(user.userId).toBe("sub-123");
        expect(user.email).toBe("jane@example.com");
        expect(user.provider).toBe(EIdentityProvider.COGNITO);
        expect(user.country).toBe("ZA");
        expect(user.services).toEqual(["netflix"]);
        expect(user.ratingsAllowed).toEqual([]);
        expect(user.genrePrefs).toEqual({});
        expect(user.votes).toEqual({});
        expect(user.dailyCount).toBe(0);
        expect(auth.deleted).toEqual([]);
    });

    test("removes the Cognito user again when the profile cannot be saved", async () => {
        const auth = new FakeAuthService();
        const repository = new FakeUserRepository();
        repository.failWith = new Error("DynamoDB is down");
        const service = new UserServiceImpl(auth, repository);

        await expect(service.createUser({ email: "jane@example.com", fullName: "Jane Doe", country: "ZA" }))
            .rejects.toThrow("DynamoDB is down");

        expect(auth.deleted).toEqual(["cognito-generated-name"]);
        expect(repository.saved).toHaveLength(0);
    });
});

describe("UserServiceImpl.createProfile (federated identities)", () => {
    const googleIdentity: IIdentity = {
        userId: "sub-google",
        username: "Google_1234567890",
        email: "jane@gmail.com",
        provider: EIdentityProvider.GOOGLE,
    };

    test("creates a profile without touching the auth provider, leaving country for onboarding", async () => {
        const auth = new FakeAuthService();
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(auth, repository);

        const user = await service.createProfile(googleIdentity);

        expect(auth.created).toEqual([]);
        expect(repository.saved).toHaveLength(1);
        expect(user.userId).toBe("sub-google");
        expect(user.email).toBe("jane@gmail.com");
        expect(user.provider).toBe(EIdentityProvider.GOOGLE);
        expect(user.country).toBeUndefined();
        expect(user.onboardedAt).toBeUndefined();
    });

    test("returns the existing profile instead of failing when called twice", async () => {
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(new FakeAuthService(), repository);

        const first = await service.createProfile(googleIdentity, { country: "za" });
        const second = await service.createProfile(googleIdentity);

        expect(repository.saved).toHaveLength(1);
        expect(second).toEqual(first);
        expect(second.country).toBe("ZA");
    });
});

describe("isFullyOnboarded", () => {
    test("requires services, ratingsAllowed and genrePrefs to all be non-empty", () => {
        const complete = { services: ["netflix"], ratingsAllowed: ["PG"], genrePrefs: { comedy: 0.8 } };

        expect(isFullyOnboarded(complete)).toBe(true);
        expect(isFullyOnboarded({ ...complete, services: [] })).toBe(false);
        expect(isFullyOnboarded({ ...complete, ratingsAllowed: [] })).toBe(false);
        expect(isFullyOnboarded({ ...complete, genrePrefs: {} })).toBe(false);
    });
});

describe("UserServiceImpl onboarding and updates", () => {
    const identity: IIdentity = { userId: "sub-9", username: "uuid-9", email: "sam@example.com", fullName: "Sam", provider: EIdentityProvider.COGNITO };

    test("a profile created with everything filled in is onboarded straight away", async () => {
        const service = new UserServiceImpl(new FakeAuthService(), new FakeUserRepository());

        const user = await service.createProfile(identity, { country: "ZA", services: ["netflix"], ratingsAllowed: ["PG"], genrePrefs: { comedy: 1 } });

        expect(user.fullyOnboarded).toBe(true);
        expect(user.onboardedAt).toBeDefined();
    });

    test("becomes onboarded once the last missing field arrives, and stamps onboardedAt only once", async () => {
        const auth = new FakeAuthService();
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(auth, repository);
        await service.createProfile(identity, { services: ["netflix"] });

        const partial = await service.updateUser("sub-9", "uuid-9", { ratingsAllowed: ["PG"] });
        expect(partial.fullyOnboarded).toBe(false);

        const done = await service.updateUser("sub-9", "uuid-9", { genrePrefs: { drama: 0.7 } });
        expect(done.fullyOnboarded).toBe(true);
        const firstOnboardedAt = done.onboardedAt;
        expect(firstOnboardedAt).toBeDefined();

        const cleared = await service.updateUser("sub-9", "uuid-9", { services: [] });
        expect(cleared.fullyOnboarded).toBe(false);
        expect(cleared.onboardedAt).toBe(firstOnboardedAt);
    });

    test("merges votes instead of replacing them, stamping the time server-side", async () => {
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(new FakeAuthService(), repository);
        await service.createProfile(identity);

        await service.updateUser("sub-9", "uuid-9", { votes: { "movie:tmdb-movie:1": { vote: EVote.UP, requestId: "r1" } } });
        const updated = await service.updateUser("sub-9", "uuid-9", { votes: { "series:tmdb-tv:2": { vote: EVote.DOWN, requestId: "r2" } } });

        expect(Object.keys(updated.votes)).toEqual(["movie:tmdb-movie:1", "series:tmdb-tv:2"]);
        expect(updated.votes["series:tmdb-tv:2"]).toMatchObject({ vote: "down", requestId: "r2" });
        expect(updated.votes["series:tmdb-tv:2"].at).toBeDefined();
    });

    test("stores watched titles and merges ratings, and a vote can be withdrawn without touching the others", async () => {
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(new FakeAuthService(), repository);
        await service.createProfile(identity);

        await service.updateUser("sub-9", "uuid-9", {
            watched: ["movie:tmdb-movie:1"],
            ratings: { "movie:tmdb-movie:1": EFeedback.GOOD },
            votes: {
                "movie:tmdb-movie:1": { vote: EVote.UP },
                "movie:tmdb-movie:2": { vote: EVote.DOWN, requestId: "r2" },
            },
        });
        const updated = await service.updateUser("sub-9", "uuid-9", {
            ratings: { "movie:tmdb-movie:2": EFeedback.NOT_FOR_ME },
            removeVotes: ["movie:tmdb-movie:1"],
        });

        expect(updated.watched).toEqual(["movie:tmdb-movie:1"]);
        expect(updated.ratings).toEqual({ "movie:tmdb-movie:1": "good", "movie:tmdb-movie:2": "not-for-me" });
        expect(Object.keys(updated.votes)).toEqual(["movie:tmdb-movie:2"]);
    });

    test("normalises country, trims the name and mirrors a changed name to Cognito", async () => {
        const auth = new FakeAuthService();
        const service = new UserServiceImpl(auth, new FakeUserRepository());
        await service.createProfile(identity);

        const updated = await service.updateUser("sub-9", "uuid-9", { fullName: "  Samantha Doe ", country: "us" });

        expect(updated).toMatchObject({ fullName: "Samantha Doe", country: "US" });
        expect(auth.renamed).toEqual([{ username: "uuid-9", fullName: "Samantha Doe" }]);
    });

    test("getUser returns the profile and derives fullyOnboarded for profiles saved before the field existed", async () => {
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(new FakeAuthService(), repository);
        await service.createProfile(identity, { services: ["netflix"], ratingsAllowed: ["PG"], genrePrefs: { comedy: 1 } });
        delete (repository.saved[0] as Partial<IUser>).fullyOnboarded;

        const user = await service.getUser("sub-9");

        expect(user).toMatchObject({ userId: "sub-9", email: "sam@example.com", fullyOnboarded: true });
        await expect(service.getUser("nobody")).rejects.toBeInstanceOf(NotFoundError);
    });

    test("returns saved movies in myMovies order, with availability for the user's country", async () => {
        const catalog = new FakeCatalogStore([
            {
                itemId: "movie:tmdb-movie:1",
                mediaType: EMediaType.MOVIE,
                title: "First",
                availability: { ZA: { services: ["netflix"], checkedAt: "2026-10-01" }, US: { services: ["hulu"], checkedAt: "2026-10-01" } },
            },
            { itemId: "movie:tmdb-movie:2", mediaType: EMediaType.MOVIE, title: "Second", genres: ["drama"] },
        ]);
        const service = new UserServiceImpl(new FakeAuthService(), new FakeUserRepository(), catalog);
        await service.createProfile(identity, { country: "ZA" });

        const updated = await service.updateUser("sub-9", "uuid-9", { myMovies: ["movie:tmdb-movie:2", "movie:tmdb-movie:404", "movie:tmdb-movie:1"] });
        const fetched = await service.getUser("sub-9");

        for (const user of [updated, fetched]) {
            expect(user.savedMovies?.map(movie => movie.title)).toEqual(["Second", "First"]);
            expect(user.savedMovies?.[0].genres).toEqual(["drama"]);
            expect(user.savedMovies?.[1].availability?.services).toEqual(["netflix"]);
        }
    });

    test("skips the catalogue when there are no saved movies", async () => {
        const catalog = new FakeCatalogStore();
        const service = new UserServiceImpl(new FakeAuthService(), new FakeUserRepository(), catalog);
        await service.createProfile(identity);

        const user = await service.getUser("sub-9");

        expect(user.savedMovies).toEqual([]);
        expect(catalog.requested).toEqual([]);
    });

    test("returns the plan as it stands now and today's usage with the profile", async () => {
        const repository = new FakeUserRepository();
        const service = new UserServiceImpl(new FakeAuthService(), repository, new FakeCatalogStore(), { [EPlan.FREE]: 2, [EPlan.ADVANCED]: 15 });
        await service.createProfile(identity);
        const today = new Date().toISOString().slice(0, 10);
        Object.assign(repository.saved[0], { dailyCount: 1, dailyCountDate: today });

        // No plan field at all (profiles from before billing) means free.
        expect(await service.getUser("sub-9")).toMatchObject({ plan: "free", usage: { plan: "free", used: 1, limit: 2, remaining: 1 } });

        await repository.setPlan("sub-9", { plan: EPlan.ADVANCED, expiresAt: "2999-01-01T00:00:00.000Z", source: EPlanSource.APPLE, willRenew: true }, "2026-10-24T00:00:00.000Z");
        const paid = await service.getUser("sub-9");

        expect(paid).toMatchObject({ plan: "advanced", planSource: "apple", usage: { plan: "advanced", used: 1, limit: 15, remaining: 14 } });
        expect(paid.usage?.resetsAt).toMatch(/T00:00:00\.000Z$/);

        // A lapsed subscription reads as free, whatever the stored plan says.
        await repository.setPlan("sub-9", { plan: EPlan.ADVANCED, expiresAt: "2000-01-01T00:00:00.000Z" }, "2026-10-24T00:00:00.000Z");
        expect(await service.getUser("sub-9")).toMatchObject({ plan: "free", usage: { limit: 2 } });

        // An update reports the same.
        expect(await service.updateUser("sub-9", "uuid-9", { country: "ZA" })).toMatchObject({ plan: "free", usage: { limit: 2 } });
    });

    test("rejects an empty update and an unknown user", async () => {
        const service = new UserServiceImpl(new FakeAuthService(), new FakeUserRepository());
        await service.createProfile(identity);

        await expect(service.updateUser("sub-9", "uuid-9", {})).rejects.toBeInstanceOf(ValidationError);
        await expect(service.updateUser("nobody", undefined, { country: "ZA" })).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe("UpdateUserRequest.fromBody", () => {
    test("accepts a partial update", async () => {
        const request = await UpdateUserRequest.fromBody(JSON.stringify({
            services: ["netflix"],
            votes: { "movie:tmdb-movie:508442": { vote: "up", requestId: "01J9QW5N3DF7H9K2M4P6R8T0VB" } },
        }));

        expect(request.services).toEqual(["netflix"]);
    });

    test("rejects out-of-range genre weights, malformed votes and invalid countries", async () => {
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ genrePrefs: { comedy: 2 } }))).rejects.toThrow(/genrePrefs.comedy/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ votes: { "tmdb:1": { vote: "up", requestId: "r" } } }))).rejects.toThrow(/not a valid item id/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ votes: { "movie:tmdb-movie:1": { vote: "meh" } } }))).rejects.toThrow(/vote must be one of/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ country: "ZAF" }))).rejects.toThrow(/country/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ myMovies: ["tmdb:1"] }))).rejects.toThrow(/myMovies entry tmdb:1/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ watched: ["tmdb:1"] }))).rejects.toThrow(/watched entry tmdb:1/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ ratings: { "movie:tmdb-movie:1": "meh" } }))).rejects.toThrow(/ratings.movie:tmdb-movie:1 must be one of/);
        await expect(UpdateUserRequest.fromBody(JSON.stringify({ votes: { "movie:tmdb-movie:1": { vote: "up", requestId: "" } } }))).rejects.toThrow(/requestId/);
    });

    test("accepts a vote without a request id, watched titles, ratings and vote removals", async () => {
        const request = await UpdateUserRequest.fromBody(JSON.stringify({
            votes: { "movie:tmdb-movie:1": { vote: "down" } },
            watched: ["movie:tmdb-movie:2"],
            ratings: { "movie:tmdb-movie:2": "perfect" },
            removeVotes: ["movie:tmdb-movie:3"],
        }));

        expect(request.watched).toEqual(["movie:tmdb-movie:2"]);
        expect(request.removeVotes).toEqual(["movie:tmdb-movie:3"]);
    });
});

describe("CreateUserRequest.fromBody", () => {
    test("rejects a body that is not JSON", async () => {
        await expect(CreateUserRequest.fromBody("not json")).rejects.toBeInstanceOf(ValidationError);
    });

    test("rejects an invalid email and country", async () => {
        const body = JSON.stringify({ email: "not-an-email", country: "USA" });

        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/email/);
        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/country/);
    });

    test("requires a full name", async () => {
        const body = JSON.stringify({ email: "jane@example.com", country: "ZA" });

        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/fullName/);
    });

    test("rejects a short password", async () => {
        const body = JSON.stringify({ email: "jane@example.com", fullName: "Jane Doe", country: "ZA", password: "short" });

        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/password/);
    });

    test("accepts a valid body", async () => {
        const body = JSON.stringify({ email: "jane@example.com", fullName: "Jane Doe", country: "ZA", services: ["netflix"] });

        const request = await CreateUserRequest.fromBody(body);

        expect(request.email).toBe("jane@example.com");
        expect(request.country).toBe("ZA");
        expect(request.services).toEqual(["netflix"]);
    });
});
