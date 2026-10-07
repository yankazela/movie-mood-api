import { ICompleteNewPasswordInput, ISignInInput } from "./domain/types";
import { ISessionResult } from "./domain/session";

export interface SessionService {
    /** Email/password sign-in. On success the result carries the tokens and the user's profile. */
    signIn(input: ISignInInput): Promise<ISessionResult>;

    /** Completes the new-password challenge; on success, same shape as signIn. */
    completeNewPassword(input: ICompleteNewPasswordInput): Promise<ISessionResult>;
}
