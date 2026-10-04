import { ICompleteNewPasswordInput, ISignInInput, ISignInResult } from "./domain/types";
import { IIdentity } from "../users/domain/types";

export interface AuthService {
    /**
     * Creates the identity for `email`. When `password` is supplied it is set as the
     * permanent password and no invitation is sent; otherwise the provider sends an
     * invitation with a temporary password.
     */
    createUser(email: string, password?: string): Promise<IIdentity>;

    deleteUser(username: string): Promise<void>;

    /**
     * Email/password sign-in. Resolves to tokens, or to a pending challenge the caller
     * must complete first. Rejects with UnauthorizedError when the credentials are wrong.
     */
    signIn(input: ISignInInput): Promise<ISignInResult>;

    /** Completes the NEW_PASSWORD_REQUIRED challenge issued to invited users on first sign-in. */
    completeNewPassword(input: ICompleteNewPasswordInput): Promise<ISignInResult>;
}
