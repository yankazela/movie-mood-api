import { ICreateUserInput, IIdentity, IProfileInput, IUpdateUserInput, IUser } from "./domain/types";

export interface UserService {
    /**
     * Email/password sign-up: creates the identity in the auth provider, then the profile.
     * If the profile cannot be saved the identity is removed again, so neither is left
     * behind without the other.
     */
    createUser(input: ICreateUserInput): Promise<IUser>;

    /**
     * Creates the profile for an identity that already exists, such as a user Cognito
     * created on first Google or Apple sign-in. Idempotent: if the profile exists it is
     * returned unchanged.
     */
    createProfile(identity: IIdentity, input?: IProfileInput): Promise<IUser>;

    /**
     * Applies a partial profile update and recomputes fullyOnboarded. `username` is the caller's
     * Cognito username, used to keep the provider's display name in step when fullName changes.
     */
    updateUser(userId: string, username: string | undefined, input: IUpdateUserInput): Promise<IUser>;

    /** The user's profile. Throws NotFoundError when it does not exist. */
    getUser(userId: string): Promise<IUser>;
}
