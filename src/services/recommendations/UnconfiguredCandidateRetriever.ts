import { CandidateRetriever } from "./CandidateRetriever";
import { ICandidate } from "./domain/types";
import { ServiceUnavailableError } from "../common/errors";

/** Stands in when no vector index is configured, so the API fails clearly instead of crashing. */
export class UnconfiguredCandidateRetriever implements CandidateRetriever {
    public async retrieve(): Promise<ICandidate[]> {
        throw new ServiceUnavailableError(
            "Recommendation retrieval is not configured (VECTOR_BUCKET_NAME / VECTOR_INDEX_NAME are unset).",
        );
    }
}
