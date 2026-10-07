import { AuthService } from "../src/services/auth/AuthService";
import { NotFoundError, ProfileAlreadyExistsError, ValidationError } from "../src/services/common/errors";
import { ISignInResult } from "../src/services/auth/domain/types";
import { EIdentityProvider, EVote, IIdentity, IUser, IVote } from "../src/services/users/domain/types";
import { UpdateUserRequest } from "../src/services/users/dto/UpdateUserRequest";
import { isFullyOnboarded } from "../src/services/users/onboarding";
import { CreateUserRequest } from "../src/services/users/dto/CreateUserRequest";
import { UserFieldChanges, UserRepository } from "../src/services/users/UserRepository";
import { UserServiceImpl } from "../src/services/users/UserServiceImpl";

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

    async update(userId: string, changes: UserFieldChanges, votes: Record<string, IVote>): Promise<IUser> {
        const current = this.saved.find(user => user.userId === userId);
        if (!current) throw new NotFoundError("missing");
        const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
        Object.assign(current, defined, { votes: { ...current.votes, ...votes } });
        return current;
    }

    async incrementDailyCount(): Promise<number> {
        throw new Error("incrementDailyCount is not exercised by the user service tests");
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
