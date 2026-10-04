import {
    AdminInitiateAuthCommand,
    AdminRespondToAuthChallengeCommand,
    CognitoIdentityProviderClient,
    NotAuthorizedException,
} from "@aws-sdk/client-cognito-identity-provider";
import { AuthServiceImpl } from "../src/services/auth/AuthServiceImpl";
import { EAuthChallenge } from "../src/services/auth/domain/types";
import { CompleteNewPasswordRequest } from "../src/services/auth/dto/CompleteNewPasswordRequest";
import { SignInRequest } from "../src/services/auth/dto/SignInRequest";
import { parseRequest } from "../src/services/common/RequestParser";
import { UnauthorizedError, ValidationError } from "../src/services/common/errors";

/** Stands in for the Cognito SDK client: records every command and answers with `respond`. */
class FakeCognitoClient {
    public sent: any[] = [];

    constructor(private readonly respond: (command: any) => any) {}

    async send(command: any): Promise<any> {
        this.sent.push(command);
        return this.respond(command);
    }
}

const tokens = { IdToken: "id", AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600, TokenType: "Bearer" };

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
            tokens: { idToken: "id", accessToken: "access", refreshToken: "refresh", expiresIn: 3600, tokenType: "Bearer" },
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
