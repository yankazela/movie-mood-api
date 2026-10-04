export enum EAuthChallenge {
    /** Issued to invited users signing in with their temporary password for the first time. */
    NEW_PASSWORD_REQUIRED = "NEW_PASSWORD_REQUIRED",
}

export interface IAuthTokens {
    idToken: string;
    accessToken: string;
    /** Absent when Cognito does not issue a new refresh token, e.g. on some challenge completions. */
    refreshToken?: string;
    /** Lifetime of the id and access tokens, in seconds. */
    expiresIn: number;
    tokenType: string;
}

export interface IAuthenticated {
    outcome: "authenticated";
    tokens: IAuthTokens;
}

/** Sign-in cannot finish until the caller completes the named challenge using `session`. */
export interface IChallengePending {
    outcome: "challenge";
    challenge: EAuthChallenge;
    session: string;
}

export type ISignInResult = IAuthenticated | IChallengePending;

export interface ISignInInput {
    email: string;
    password: string;
}

export interface ICompleteNewPasswordInput {
    email: string;
    newPassword: string;
    /** The session returned with the NEW_PASSWORD_REQUIRED challenge. */
    session: string;
}
