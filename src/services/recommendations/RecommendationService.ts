import { IRecommendInput, IRecommendationResult } from "./domain/types";

export interface RecommendationService {
    /**
     * Runs the text path end to end: guard (daily cap, profile), resolve the mood, apply the
     * objective, retrieve and re-rank candidates (relaxing constraints if needed), explain,
     * persist the request and return the result.
     */
    recommend(input: IRecommendInput): Promise<IRecommendationResult>;
}
