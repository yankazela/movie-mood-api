import { IUser } from "./domain/types";

export interface UserRepository {
    /** Persists a new user. Throws ProfileAlreadyExistsError if the userId is already taken. */
    create(user: IUser): Promise<void>;

    findById(userId: string): Promise<IUser | null>;

    /**
     * Adds one to the user's request counter for `today` (UTC, YYYY-MM-DD). A counter stored
     * for an earlier day restarts at one. Resolves to the new count.
     */
    incrementDailyCount(userId: string, today: string): Promise<number>;
}
