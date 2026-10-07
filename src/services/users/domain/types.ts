export enum EIdentityProvider {
    COGNITO = "cognito",
    GOOGLE = "google",
    APPLE = "apple",
}

export enum EVote {
    UP = "up",
    DOWN = "down",
}

/** A thumbs vote on an item, carrying the request that recommended it so the two can be joined. */
export interface IVote {
    vote: EVote;
    requestId: string;
    at: string;
}

/** Item shape of the Users table. Partition key: userId, which is the Cognito `sub`. */
export interface IUser {
    userId: string;
    email: string;
    /** Display name. Federated users get it from their provider when it shares one. */
    fullName?: string;
    /** Where the identity comes from. Federated users are created by Cognito on first sign-in. */
    provider: EIdentityProvider;
    /** ISO 3166-1 alpha-2. Unknown for federated users until they complete onboarding. */
    country?: string;
    services: string[];
    ratingsAllowed: string[];
    genrePrefs: Record<string, number>;
    /** Item id to the user's thumbs vote. */
    votes: Record<string, IVote>;
    /** When the profile first became fully onboarded. */
    onboardedAt?: string;
    createdAt: string;
    /** Recommendation requests made on `dailyCountDate`. Stale when that date is not today. */
    dailyCount: number;
    /** UTC day (YYYY-MM-DD) that dailyCount refers to. */
    dailyCountDate?: string;
    /** True when services, ratingsAllowed and genrePrefs are all non-empty. See isFullyOnboarded. */
    fullyOnboarded: boolean;
}

/** Profile details a user may supply when the profile is created. All optional until onboarding. */
export interface IProfileInput {
    country?: string;
    services?: string[];
    ratingsAllowed?: string[];
    genrePrefs?: Record<string, number>;
}

/** Input for creating an email/password user through the API. */
export interface ICreateUserInput extends IProfileInput {
    email: string;
    fullName: string;
    country: string;
    password?: string;
}

/** A thumbs vote as sent by the client; the server stamps `at`. */
export interface IVoteInput {
    vote: EVote;
    requestId: string;
}

/** Fields a user may change on their profile. Omitted fields are left as they are. */
export interface IUpdateUserInput {
    fullName?: string;
    country?: string;
    services?: string[];
    ratingsAllowed?: string[];
    /** Replaces the whole map. */
    genrePrefs?: Record<string, number>;
    /** Merged into the existing votes, one entry per item id; other votes are kept. */
    votes?: Record<string, IVoteInput>;
}

/** An identity that exists in the auth provider, however it got there. */
export interface IIdentity {
    /** Stable unique id (the Cognito `sub`). Used as the Users table partition key. */
    userId: string;
    /** The name Cognito knows the user by, e.g. a UUID, `Google_<id>` or `SignInWithApple_<id>`. */
    username: string;
    email: string;
    fullName?: string;
    provider: EIdentityProvider;
}
