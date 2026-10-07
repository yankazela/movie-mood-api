import { IAuthenticated, IChallengePending } from "./types";
import { IUser } from "../../users/domain/types";

export interface IAuthenticatedSession extends IAuthenticated {
    /** The signed-in user's profile; null only if the identity exists without a profile. */
    user: IUser | null;
}

export type ISessionResult = IAuthenticatedSession | IChallengePending;
