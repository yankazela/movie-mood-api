import { IAvailability } from "../../movies/domain/types";

export enum EObjective {
    /** Match the current mood. */
    KEEP = "keep",
    /** Lift the mood: brighter, calmer, with uplift. */
    IMPROVE = "improve",
}

export enum EInputType {
    TEXT = "text",
    VOICE = "voice",
}

/** Structured reading of how the user feels, produced by the mood resolver. */
export interface IMoodProfile {
    primary_emotion: string;
    /** Pleasantness, -1 (very negative) to 1 (very positive). */
    valence: number;
    /** Energy, -1 (flat, tired) to 1 (agitated, wired). */
    arousal: number;
    themes_seek: string[];
    themes_avoid: string[];
    constraints: {
        max_runtime_min?: number;
    };
    confidence: number;
    /** True when the message suggests the person may be at risk. The flow stops; no movies are ranked. */
    safety_flag: boolean;
    /** Only present when safety_flag is true: what to say back to the person. */
    supportive_message?: string;
}

/** The mood we aim the retrieval at, after the objective has been applied. */
export interface ITarget {
    valence: number;
    arousal: number;
    themes_seek: string[];
}

export interface IRetrievalFilters {
    country: string;
    /** Streaming services the user has; empty means any service available in the country. */
    services: string[];
    /** Content ratings the user allows; empty means no restriction. */
    ratingsAllowed: string[];
    maxRuntimeMin?: number;
}

/** A movie as returned by the vector index, before re-ranking. */
export interface ICandidate {
    movieId: string;
    /** Index similarity score; only its order within one result set matters. */
    similarity: number;
    popularity: number;
    year?: number;
    primaryGenre?: string;
    genres: string[];
    runtime?: number;
}

export interface IRankedCandidate extends ICandidate {
    score: number;
}

/** Item shape of the Requests table. Partition key: userId, sort key: requestedAt. */
export interface IRecommendationRequest {
    userId: string;
    requestedAt: string;
    requestId: string;
    inputType: EInputType;
    text: string;
    objective: EObjective;
    moodProfile: IMoodProfile;
    target: ITarget;
    resultIds: string[];
    resolver: string;
    latencyMs: number;
    /** Epoch seconds; DynamoDB deletes the item after this (90 days). */
    ttl: number;
}

export interface IRecommendInput {
    userId: string;
    text: string;
    objective: EObjective;
    inputType?: EInputType;
    /** From the JWT when present; otherwise the profile's value is used. */
    country?: string;
    services?: string[];
}

export interface IRecommendedMovie {
    movieId: string;
    title: string;
    year?: number;
    runtime?: number;
    genres: string[];
    posterKey?: string;
    /** Availability in the user's country. */
    availability?: IAvailability;
    why?: string;
}

export interface IRecommendationResult {
    requestId: string;
    moodProfile: IMoodProfile;
    target: ITarget;
    results: IRecommendedMovie[];
    /** Set when fewer than the usual number of titles survived even after relaxing constraints. */
    notice?: "few_matches";
    latencyMs: number;
}
