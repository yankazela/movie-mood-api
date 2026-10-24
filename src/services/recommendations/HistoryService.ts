import { EFeedback, EObjective, IMoodProfile, IRecommendedItem, IRequestFilters, ITarget } from "./domain/types";

/** One past recommendation request, with the titles it returned. */
export interface IHistoryEntry {
    requestId: string;
    requestedAt: string;
    text: string;
    objective: EObjective;
    moods?: string[];
    filters?: IRequestFilters;
    moodProfile: IMoodProfile;
    target: ITarget;
    /** In the order they were recommended; titles since removed from the catalogue are left out. */
    results: IRecommendedItem[];
    selectedItemId?: string;
    feedback?: EFeedback;
}

export interface IOutcomeInput {
    selectedItemId?: string;
    feedback?: EFeedback;
}

export interface HistoryService {
    /** The user's most recent requests, newest first. */
    list(userId: string, limit?: number): Promise<IHistoryEntry[]>;

    /** Records the title the user chose and/or how the results went. Throws NotFoundError for an unknown request. */
    recordOutcome(userId: string, requestId: string, input: IOutcomeInput): Promise<IHistoryEntry>;
}
