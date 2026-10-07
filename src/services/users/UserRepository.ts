import { IUser, IVote } from "./domain/types";

/** Top-level profile fields that can be overwritten in place. */
export type UserFieldChanges = Partial<Pick<IUser, "fullName" | "country" | "services" | "ratingsAllowed" | "genrePrefs" | "fullyOnboarded" | "onboardedAt">>;

export interface UserRepository {
    /** Persists a new user. Throws ProfileAlreadyExistsError if the userId is already taken. */
    create(user: IUser): Promise<void>;

    findById(userId: string): Promise<IUser | null>;

    /**
     * Overwrites the given fields and sets individual entries of the votes map, leaving every
     * other vote untouched. Throws NotFoundError when the profile does not exist. Resolves to the
     * updated profile.
     */
    update(userId: string, changes: UserFieldChanges, votes: Record<string, IVote>): Promise<IUser>;

    /**
     * Adds one to the user's request counter for `today` (UTC, YYYY-MM-DD). A counter stored
     * for an earlier day restarts at one. Resolves to the new count.
     */
    incrementDailyCount(userId: string, today: string): Promise<number>;
}
