import { ICandidate, IRetrievalFilters } from "./domain/types";

export interface CandidateRetriever {
    /** Returns up to `count` movies nearest to `vector` that satisfy the filters. */
    retrieve(vector: number[], filters: IRetrievalFilters, count: number): Promise<ICandidate[]>;
}
