import {
    AdminInitiateAuthCommand,
    AdminRespondToAuthChallengeCommand,
    CognitoIdentityProviderClient,
    NotAuthorizedException,
} from "@aws-sdk/client-cognito-identity-provider";
import { AuthService } from "../src/services/auth/AuthService";
import { AuthServiceImpl, subjectOf } from "../src/services/auth/AuthServiceImpl";
import { SessionServiceImpl } from "../src/services/auth/SessionServiceImpl";
import { UserService } from "../src/services/users/UserService";
import { IUser } from "../src/services/users/domain/types";
import { EAuthChallenge, ISignInResult } from "../src/services/auth/domain/types";
import { CompleteNewPasswordRequest } from "../src/services/auth/dto/CompleteNewPasswordRequest";
import { SignInRequest } from "../src/services/auth/dto/SignInRequest";
import { parseRequest } from "../src/services/common/RequestParser";
import { NotFoundError, UnauthorizedError, ValidationError } from "../src/services/common/errors";

/** Stands in for the Cognito SDK client: records every command and answers with `respond`. */
class FakeCognitoClient {
    public sent: any[] = [];

    constructor(private readonly respond: (command: any) => any) {}

    async send(command: any): Promise<any> {
        this.sent.push(command);
        return this.respond(command);
    }
}

/** An unsigned JWT-shaped token carrying the given sub; enough for the service to read the claim. */
function idTokenFor(sub: string): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode({ sub, email: "jane@example.com" })}.sig`;
}

const idToken = idTokenFor("sub-123");
const tokens = { IdToken: idToken, AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600, TokenType: "Bearer" };

function serviceWith(respond: (command: any) => any): { service: AuthServiceImpl; client: FakeCognitoClient } {
    const client = new FakeCognitoClient(respond);
    const service = new AuthServiceImpl(client as unknown as CognitoIdentityProviderClient, "pool-id", "client-id");
    return { service, client };
}

describe("AuthServiceImpl.signIn", () => {
    test("returns tokens from the admin password auth flow", async () => {
        const { service, client } = serviceWith(() => ({ AuthenticationResult: tokens }));

        const result = await service.signIn({ email: " Jane@Example.com ", password: "secret" });

        expect(client.sent[0]).toBeInstanceOf(AdminInitiateAuthCommand);
        expect(client.sent[0].input).toMatchObject({
            UserPoolId: "pool-id",
            ClientId: "client-id",
            AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: "jane@example.com", PASSWORD: "secret" },
        });
        expect(result).toEqual({
            outcome: "authenticated",
            userId: "sub-123",
            tokens: { idToken, accessToken: "access", refreshToken: "refresh", expiresIn: 3600, tokenType: "Bearer" },
        });
    });

    test("surfaces the new-password challenge for invited users", async () => {
        const { service } = serviceWith(() => ({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "session-token" }));

        const result = await service.signIn({ email: "jane@example.com", password: "TempPass1!" });

        expect(result).toEqual({ outcome: "challenge", challenge: EAuthChallenge.NEW_PASSWORD_REQUIRED, session: "session-token" });
    });

    test("maps rejected credentials to UnauthorizedError", async () => {
        const { service } = serviceWith(() => {
            throw new NotAuthorizedException({ message: "Incorrect username or password.", $metadata: {} });
        });

        await expect(service.signIn({ email: "jane@example.com", password: "wrong" }))
            .rejects.toBeInstanceOf(UnauthorizedError);
    });

    test("fails loudly on a challenge it does not support", async () => {
        const { service } = serviceWith(() => ({ ChallengeName: "SMS_MFA", Session: "s" }));

        await expect(service.signIn({ email: "jane@example.com", password: "pw" }))
            .rejects.toThrow(/Unsupported sign-in challenge/);
    });
});

describe("AuthServiceImpl.completeNewPassword", () => {
    test("answers the challenge with the new password and returns tokens", async () => {
        const { service, client } = serviceWith(() => ({ AuthenticationResult: tokens }));

        const result = await service.completeNewPassword({ email: "jane@example.com", newPassword: "N3w!Password", session: "session-token" });

        expect(client.sent[0]).toBeInstanceOf(AdminRespondToAuthChallengeCommand);
        expect(client.sent[0].input).toMatchObject({
            ChallengeName: "NEW_PASSWORD_REQUIRED",
            ChallengeResponses: { USERNAME: "jane@example.com", NEW_PASSWORD: "N3w!Password" },
            Session: "session-token",
        });
        expect(result.outcome).toBe("authenticated");
    });
});

describe("auth request DTOs", () => {
    test("sign-in requires an email and a password", async () => {
        await expect(parseRequest(JSON.stringify({ email: "jane@example.com" }), SignInRequest))
            .rejects.toThrow(/password/);
        await expect(parseRequest(JSON.stringify({ email: "nope", password: "x" }), SignInRequest))
            .rejects.toBeInstanceOf(ValidationError);
    });

    test("new-password completion requires a session and a password of at least 8 characters", async () => {
        await expect(parseRequest(JSON.stringify({ email: "jane@example.com", newPassword: "short", session: "s" }), CompleteNewPasswordRequest))
            .rejects.toThrow(/newPassword/);
        await expect(parseRequest(JSON.stringify({ email: "jane@example.com", newPassword: "LongEnough1!" }), CompleteNewPasswordRequest))
            .rejects.toThrow(/session/);
    });
});

describe("SessionServiceImpl", () => {
    const user = { userId: "sub-123", email: "jane@example.com" } as IUser;

    function sessionWith(signInResult: ISignInResult, getUser: (userId: string) => Promise<IUser>) {
        const auth = { signIn: async () => signInResult, completeNewPassword: async () => signInResult } as unknown as AuthService;
        const users = { getUser } as unknown as UserService;
        return new SessionServiceImpl(auth, users);
    }

    const authenticated: ISignInResult = {
        outcome: "authenticated",
        userId: "sub-123",
        tokens: { idToken, accessToken: "access", expiresIn: 3600, tokenType: "Bearer" },
    };

    test("returns the profile alongside the tokens on sign-in and on new-password completion", async () => {
        const looked: string[] = [];
        const session = sessionWith(authenticated, async userId => { looked.push(userId); return user; });

        expect(await session.signIn({ email: "jane@example.com", password: "pw" })).toMatchObject({ outcome: "authenticated", userId: "sub-123", user });
        expect(await session.completeNewPassword({ email: "jane@example.com", newPassword: "N3w!Password", session: "s" })).toMatchObject({ user });
        expect(looked).toEqual(["sub-123", "sub-123"]);
    });

    test("passes a challenge through without looking up a profile", async () => {
        const challenge: ISignInResult = { outcome: "challenge", challenge: EAuthChallenge.NEW_PASSWORD_REQUIRED, session: "s" };
        const session = sessionWith(challenge, async () => { throw new Error("should not be called"); });

        expect(await session.signIn({ email: "jane@example.com", password: "Temp" })).toEqual(challenge);
    });

    test("still signs the user in, with a null profile, when the profile is missing", async () => {
        const session = sessionWith(authenticated, async () => { throw new NotFoundError("missing"); });

        expect(await session.signIn({ email: "jane@example.com", password: "pw" })).toMatchObject({ outcome: "authenticated", user: null });
    });
});

describe("subjectOf", () => {
    test("reads sub from an ID token and rejects tokens without one", () => {
        expect(subjectOf(idTokenFor("abc"))).toBe("abc");
        expect(() => subjectOf("not-a-jwt")).toThrow(/sub claim/);
    });
});
