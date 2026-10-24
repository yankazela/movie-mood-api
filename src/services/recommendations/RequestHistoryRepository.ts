import { EFeedback, IRecommendationRequest } from "./domain/types";

export interface IRequestOutcome {
    selectedItemId?: string;
    feedback?: EFeedback;
}

/** Reads back, and annotates, the recommendation requests a user has made. */
export interface RequestHistoryRepository {
    /** The user's most recent requests, newest first. */
    listByUser(userId: string, limit: number): Promise<IRecommendationRequest[]>;

    /**
     * Records what the user did with a request: the title they chose and how it went. Throws
     * NotFoundError when no request exists at `requestedAt`.
     */
    recordOutcome(userId: string, requestedAt: string, outcome: IRequestOutcome): Promise<IRecommendationRequest>;
}
