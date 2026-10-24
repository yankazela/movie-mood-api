import { IUser, IVote } from "./domain/types";
import { EFeedback } from "../recommendations/domain/types";
import { IEntitlement } from "../billing/domain/types";

/** Top-level profile fields that can be overwritten in place. */
export type UserFieldChanges = Partial<Pick<IUser, "fullName" | "country" | "services" | "ratingsAllowed" | "genrePrefs" | "myMovies" | "watched" | "fullyOnboarded" | "onboardedAt">>;

/** Per-item changes to the maps on a profile, applied entry by entry so concurrent edits do not clash. */
export interface UserMapChanges {
    ratings?: Record<string, EFeedback>;
    removeVotes?: string[];
}

export interface UserRepository {
    /** Persists a new user. Throws ProfileAlreadyExistsError if the userId is already taken. */
    create(user: IUser): Promise<void>;

    findById(userId: string): Promise<IUser | null>;

    /**
     * Overwrites the given fields and sets individual entries of the votes map, leaving every
     * other vote untouched. Also applies `mapChanges` to the ratings and votes maps. Throws
     * NotFoundError when the profile does not exist. Resolves to the updated profile.
     */
    update(userId: string, changes: UserFieldChanges, votes: Record<string, IVote>, mapChanges?: UserMapChanges): Promise<IUser>;

    /**
     * Takes one of the user's `cap` request slots for `today` (UTC, YYYY-MM-DD), atomically, so
     * parallel requests cannot slip past the cap. A counter stored for an earlier day restarts at
     * one. Resolves to the new count, or null, with nothing changed, when today's counter has
     * already reached the cap.
     */
    reserveDailyRequest(userId: string, today: string, cap: number): Promise<number | null>;

    /** Gives back a slot taken by reserveDailyRequest when the request did not go through. */
    releaseDailyRequest(userId: string, today: string): Promise<void>;

    /**
     * Overwrites the plan fields with what the billing provider reports; fields the entitlement
     * leaves out are removed. Throws NotFoundError when the profile does not exist. Resolves to
     * the updated profile.
     */
    setPlan(userId: string, entitlement: IEntitlement, syncedAt: string): Promise<IUser>;
}
