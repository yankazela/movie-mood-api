import { AuthService } from "../src/services/auth/AuthService";
import { ProfileAlreadyExistsError, ValidationError } from "../src/services/common/errors";
import { ISignInResult } from "../src/services/auth/domain/types";
import { EIdentityProvider, IIdentity, IUser } from "../src/services/users/domain/types";
import { CreateUserRequest } from "../src/services/users/dto/CreateUserRequest";
import { UserRepository } from "../src/services/users/UserRepository";
import { UserServiceImpl } from "../src/services/users/UserServiceImpl";

class FakeAuthService implements AuthService {
    public created: { email: string; password?: string }[] = [];
    public deleted: string[] = [];

    async createUser(email: string, password?: string): Promise<IIdentity> {
        this.created.push({ email, password });
        return { userId: "sub-123", username: "cognito-generated-name", email, provider: EIdentityProvider.COGNITO };
    }

    async deleteUser(username: string): Promise<void> {
        this.deleted.push(username);
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
            country: "za",
            password: "Str0ng!Password",
            services: ["netflix"],
        });

        expect(auth.created).toEqual([{ email: "jane@example.com", password: "Str0ng!Password" }]);
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

        await expect(service.createUser({ email: "jane@example.com", country: "ZA" }))
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

describe("CreateUserRequest.fromBody", () => {
    test("rejects a body that is not JSON", async () => {
        await expect(CreateUserRequest.fromBody("not json")).rejects.toBeInstanceOf(ValidationError);
    });

    test("rejects an invalid email and country", async () => {
        const body = JSON.stringify({ email: "not-an-email", country: "USA" });

        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/email/);
        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/country/);
    });

    test("rejects a short password", async () => {
        const body = JSON.stringify({ email: "jane@example.com", country: "ZA", password: "short" });

        await expect(CreateUserRequest.fromBody(body)).rejects.toThrow(/password/);
    });

    test("accepts a valid body", async () => {
        const body = JSON.stringify({ email: "jane@example.com", country: "ZA", services: ["netflix"] });

        const request = await CreateUserRequest.fromBody(body);

        expect(request.email).toBe("jane@example.com");
        expect(request.country).toBe("ZA");
        expect(request.services).toEqual(["netflix"]);
    });
});
