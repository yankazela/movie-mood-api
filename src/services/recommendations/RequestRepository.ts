import { IRecommendationRequest } from "./domain/types";

export interface RequestRepository {
    save(request: IRecommendationRequest): Promise<void>;
}
