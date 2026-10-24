import { IAvailability } from "../../catalog/domain/items";
import { EMediaType } from "../../media/MediaType";

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

/** How a user felt about a recommendation or a title. */
export enum EFeedback {
    PERFECT = "perfect",
    GOOD = "good",
    OKAY = "okay",
    NOT_FOR_ME = "not-for-me",
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
    /** Which media the user wants back; defaults to every active type. */
    mediaTypes: EMediaType[];
    country: string;
    /** Streaming services the user has; empty means any service available in the country. */
    services: string[];
    /** Content ratings the user allows; empty means no restriction. */
    ratingsAllowed: string[];
    maxRuntimeMin?: number;
    /** Only titles with at least one of these genres (lower-case TMDB names). */
    genres?: string[];
    /** Only titles released in or after this year. */
    minYear?: number;
}

/** Constraints the user set explicitly in the app, beyond what the mood text implies. */
export interface IRequestFilters {
    maxRuntimeMin?: number;
    genres?: string[];
    releaseYearMin?: number;
    /** Minimum audience score, 0 to 10. Applied after retrieval, to titles that have a score. */
    minRating?: number;
    /** ISO 639-1 original language. Applied after retrieval, to titles that have one. */
    language?: string;
}

/** An item as returned by the vector index, before re-ranking. */
export interface ICandidate {
    itemId: string;
    mediaType: EMediaType;
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
    /** Moods the user ticked in the app, in addition to the free text. */
    moods?: string[];
    filters?: IRequestFilters;
    /** The title the user chose to watch from these results. */
    selectedItemId?: string;
    feedback?: EFeedback;
    /** Epoch seconds; DynamoDB deletes the item after this (90 days). */
    ttl: number;
}

export interface IRecommendInput {
    userId: string;
    text: string;
    objective: EObjective;
    /** Media to recommend; defaults to every active type. */
    mediaTypes?: EMediaType[];
    inputType?: EInputType;
    /** From the JWT when present; otherwise the profile's value is used. */
    country?: string;
    services?: string[];
    moods?: string[];
    filters?: IRequestFilters;
}

export interface IRecommendedItem {
    itemId: string;
    mediaType: EMediaType;
    title: string;
    year?: number;
    runtime?: number;
    genres: string[];
    posterKey?: string;
    /** Availability in the user's country. */
    availability?: IAvailability;
    /** Media-specific fields, e.g. episode and season counts for a series. */
    details?: Record<string, unknown>;
    why?: string;
    /** Content rating in the user's country, e.g. "PG-13" or "13". */
    rating?: string;
    popularity?: number;
    /** 0 to 100, how well the title fits the request. Only set on recommendation results. */
    matchScore?: number;
}

export interface IRecommendationResult {
    requestId: string;
    moodProfile: IMoodProfile;
    target: ITarget;
    results: IRecommendedItem[];
    /** Set when fewer than the usual number of titles survived even after relaxing constraints. */
    notice?: "few_matches";
    latencyMs: number;
}
