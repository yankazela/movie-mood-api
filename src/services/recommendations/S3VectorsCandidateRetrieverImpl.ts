import { CandidateRetriever } from "./CandidateRetriever";
import { ICandidate, IRetrievalFilters } from "./domain/types";
import { VectorFilter, VectorIndex, VectorMetadata } from "../vectors/VectorIndex";

/**
 * Metadata written for every movie vector by catalog-refresh, and read back here:
 *   movieId       string      e.g. "tmdb:508442"
 *   countries     string[]    country codes where the title streams on at least one service
 *   availableOn   string[]    "<country>:<service slug>" tokens, e.g. "ZA:netflix"
 *   ratings       string[]    "<country>:<certification>" tokens, e.g. "ZA:13"
 *   runtime       number      minutes
 *   popularity    number
 *   year          number
 *   primaryGenre  string
 *   genres        string[]
 */
export class S3VectorsCandidateRetrieverImpl implements CandidateRetriever {
    private readonly index: VectorIndex;

    constructor(index: VectorIndex) {
        this.index = index;
    }

    public async retrieve(vector: number[], filters: IRetrievalFilters, count: number): Promise<ICandidate[]> {
        const matches = await this.index.query(vector, buildCandidateFilter(filters), count);

        return matches
            .map(match => ({ match, movieId: stringField(match.metadata, "movieId") ?? match.key }))
            .map(({ match, movieId }) => ({
                movieId,
                // Cosine distance runs from 0 (identical) to 2 (opposite); flip it so bigger is better.
                similarity: 1 - match.distance,
                popularity: numberField(match.metadata, "popularity") ?? 0,
                year: numberField(match.metadata, "year"),
                primaryGenre: stringField(match.metadata, "primaryGenre"),
                genres: stringListField(match.metadata, "genres"),
                runtime: numberField(match.metadata, "runtime"),
            }));
    }
}

/** Translates the user's constraints into the vector store's filter syntax. */
export function buildCandidateFilter(filters: IRetrievalFilters): VectorFilter {
    const clauses: VectorFilter[] = [];

    if (filters.services.length > 0) {
        clauses.push({ availableOn: { $in: filters.services.map(service => `${filters.country}:${service}`) } });
    } else {
        clauses.push({ countries: { $eq: filters.country } });
    }

    if (filters.ratingsAllowed.length > 0) {
        clauses.push({ ratings: { $in: filters.ratingsAllowed.map(rating => `${filters.country}:${rating}`) } });
    }

    if (filters.maxRuntimeMin) {
        clauses.push({ runtime: { $lte: filters.maxRuntimeMin } });
    }

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function stringField(metadata: VectorMetadata, key: string): string | undefined {
    const value = metadata[key];
    return typeof value === "string" ? value : undefined;
}

function numberField(metadata: VectorMetadata, key: string): number | undefined {
    const value = metadata[key];
    return typeof value === "number" ? value : undefined;
}

function stringListField(metadata: VectorMetadata, key: string): string[] {
    const value = metadata[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
