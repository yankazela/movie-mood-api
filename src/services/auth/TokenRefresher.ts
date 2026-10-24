import { IAuthenticated } from "./domain/types";

/** Exchanges a refresh token for fresh id and access tokens. */
export interface TokenRefresher {
    /** Rejects with UnauthorizedError when the refresh token is invalid, expired or revoked. */
    refresh(refreshToken: string): Promise<IAuthenticated>;
}
