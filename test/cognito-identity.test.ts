import { identityFromCognitoUser } from "../src/services/auth/CognitoIdentity";
import { EIdentityProvider } from "../src/services/users/domain/types";

describe("identityFromCognitoUser", () => {
    test("treats a user without an identities attribute as a native Cognito user", () => {
        const identity = identityFromCognitoUser("3f1a-uuid", { sub: "sub-1", email: "Jane@Example.com" });

        expect(identity).toEqual({
            userId: "sub-1",
            username: "3f1a-uuid",
            email: "jane@example.com",
            provider: EIdentityProvider.COGNITO,
        });
    });

    test("recognises a Google sign-in", () => {
        const identities = JSON.stringify([
            { userId: "1234567890", providerName: "Google", providerType: "Google", issuer: null, primary: true, dateCreated: 1700000000000 },
        ]);

        const identity = identityFromCognitoUser("Google_1234567890", { sub: "sub-2", email: "jane@gmail.com", identities });

        expect(identity.provider).toBe(EIdentityProvider.GOOGLE);
        expect(identity.username).toBe("Google_1234567890");
    });

    test("recognises a Sign in with Apple sign-in", () => {
        const identities = JSON.stringify([
            { userId: "001234.abcdef", providerName: "SignInWithApple", providerType: "SignInWithApple", primary: true },
        ]);

        const identity = identityFromCognitoUser("SignInWithApple_001234.abcdef", { sub: "sub-3", email: "relay@privaterelay.appleid.com", identities });

        expect(identity.provider).toBe(EIdentityProvider.APPLE);
    });

    test("rejects a provider it does not know", () => {
        const identities = JSON.stringify([{ userId: "x", providerName: "Facebook", primary: true }]);

        expect(() => identityFromCognitoUser("Facebook_x", { sub: "sub-4", email: "a@b.com", identities }))
            .toThrow(/Unsupported identity provider/);
    });

    test("rejects a user without an email", () => {
        expect(() => identityFromCognitoUser("Google_1", { sub: "sub-5" })).toThrow(/no email attribute/);
    });
});
