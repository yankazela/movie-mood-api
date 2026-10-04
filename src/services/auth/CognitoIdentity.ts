import { EIdentityProvider, IIdentity } from "../users/domain/types";

/** Cognito's names for federated providers, as they appear in a user's `identities` attribute. */
const PROVIDER_BY_COGNITO_NAME: Record<string, EIdentityProvider> = {
    Google: EIdentityProvider.GOOGLE,
    SignInWithApple: EIdentityProvider.APPLE,
};

interface CognitoFederatedIdentity {
    providerName: string;
    userId: string;
    primary?: boolean;
}

export type CognitoUserAttributes = Record<string, string | undefined>;

/**
 * Builds an identity from a Cognito user's attributes. Works both for users created with
 * AdminCreateUser (no `identities` attribute) and for users Cognito created itself on first
 * federated sign-in, whose `identities` attribute names the external provider.
 */
export function identityFromCognitoUser(username: string, attributes: CognitoUserAttributes): IIdentity {
    const userId = attributes.sub;
    const email = attributes.email;

    if (!userId) {
        throw new Error(`Cognito user ${username} has no sub attribute`);
    }

    if (!email) {
        throw new Error(`Cognito user ${username} has no email attribute`);
    }

    return {
        userId,
        username,
        email: email.trim().toLowerCase(),
        provider: providerFrom(attributes.identities, username),
    };
}

function providerFrom(identitiesJson: string | undefined, username: string): EIdentityProvider {
    if (!identitiesJson) {
        return EIdentityProvider.COGNITO;
    }

    let identities: CognitoFederatedIdentity[];

    try {
        identities = JSON.parse(identitiesJson);
    } catch {
        throw new Error(`Cognito user ${username} has an unreadable identities attribute`);
    }

    const primary = identities.find(identity => identity.primary) ?? identities[0];

    if (!primary) {
        return EIdentityProvider.COGNITO;
    }

    const provider = PROVIDER_BY_COGNITO_NAME[primary.providerName];

    if (!provider) {
        throw new Error(`Unsupported identity provider for ${username}: ${primary.providerName}`);
    }

    return provider;
}
