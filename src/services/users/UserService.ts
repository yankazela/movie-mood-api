import { ICreateUserInput, IIdentity, IProfileInput, IUser } from "./domain/types";

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
}
