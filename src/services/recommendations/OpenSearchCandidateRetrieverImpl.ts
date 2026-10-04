import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { CandidateRetriever } from "./CandidateRetriever";
import { ICandidate, IRetrievalFilters } from "./domain/types";
import { DEFAULT_MOVIES_INDEX } from "./config";
import { ServiceUnavailableError } from "../common/errors";

/**
 * Expected document shape in the movies index, written by catalog-refresh:
 *   movieId       keyword
 *   embedding     knn_vector (EMBEDDING_DIMENSIONS, same model as the Embedder)
 *   countries     keyword[]   country codes where the title is available at all
 *   availableOn   keyword[]   "<country>:<service>" tokens, e.g. "ZA:netflix"
 *   ratings       keyword[]   "<country>:<rating>" tokens, e.g. "ZA:PG-13"
 *   runtime       integer     minutes
 *   popularity    float
 *   year          integer
 *   primaryGenre  keyword
 *   genres        keyword[]
 */
interface MovieDocument {
    movieId: string;
    popularity?: number;
    year?: number;
    primaryGenre?: string;
    genres?: string[];
    runtime?: number;
}

interface SearchHit {
    _score: number;
    _source: MovieDocument;
}

export class OpenSearchCandidateRetrieverImpl implements CandidateRetriever {
    private readonly client: Client;
    private readonly index: string;

    constructor(client: Client, index: string = process.env.MOVIES_INDEX || DEFAULT_MOVIES_INDEX) {
        this.client = client;
        this.index = index;
    }

    /** Builds a SigV4-signed client from OPENSEARCH_ENDPOINT, or null when no endpoint is configured. */
    public static fromEnvironment(): OpenSearchCandidateRetrieverImpl | null {
        const endpoint = process.env.OPENSEARCH_ENDPOINT;

        if (!endpoint) {
            return null;
        }

        const service = process.env.OPENSEARCH_SERVICE === "aoss" ? "aoss" : "es";
        const region = process.env.AWS_REGION || "us-east-1";
        const client = new Client({
            ...AwsSigv4Signer({ region, service, getCredentials: () => defaultProvider()() }),
            node: endpoint.startsWith("http") ? endpoint : `https://${endpoint}`,
        });

        return new OpenSearchCandidateRetrieverImpl(client);
    }

    public async retrieve(vector: number[], filters: IRetrievalFilters, count: number): Promise<ICandidate[]> {
        const response = await this.client.search({
            index: this.index,
            body: {
                size: count,
                _source: ["movieId", "popularity", "year", "primaryGenre", "genres", "runtime"],
                query: {
                    knn: {
                        embedding: {
                            vector,
                            k: count,
                            filter: { bool: { filter: buildFilters(filters) } },
                        },
                    },
                },
            },
        });

        const hits = (response.body.hits?.hits ?? []) as SearchHit[];

        return hits
            .filter(hit => hit._source?.movieId)
            .map(hit => ({
                movieId: hit._source.movieId,
                similarity: hit._score,
                popularity: hit._source.popularity ?? 0,
                year: hit._source.year,
                primaryGenre: hit._source.primaryGenre,
                genres: hit._source.genres ?? [],
                runtime: hit._source.runtime,
            }));
    }
}

function buildFilters(filters: IRetrievalFilters): object[] {
    const clauses: object[] = [];

    if (filters.services.length > 0) {
        clauses.push({ terms: { availableOn: filters.services.map(service => `${filters.country}:${service}`) } });
    } else {
        clauses.push({ terms: { countries: [filters.country] } });
    }

    if (filters.ratingsAllowed.length > 0) {
        clauses.push({ terms: { ratings: filters.ratingsAllowed.map(rating => `${filters.country}:${rating}`) } });
    }

    if (filters.maxRuntimeMin) {
        clauses.push({ range: { runtime: { lte: filters.maxRuntimeMin } } });
    }

    return clauses;
}

/** Stands in when no vector backend is configured, so the API fails clearly instead of crashing. */
export class UnconfiguredCandidateRetriever implements CandidateRetriever {
    public async retrieve(): Promise<ICandidate[]> {
        throw new ServiceUnavailableError("Recommendation retrieval is not configured (OPENSEARCH_ENDPOINT is unset).");
    }
}
