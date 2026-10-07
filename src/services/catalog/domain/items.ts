import { EMediaType } from "../../media/MediaType";

/** A cached one-line explanation of why an item suits a mood, keyed in ICatalogItem.why by `emotion#objective`. */
export interface IWhyEntry {
    text: string;
    model: string;
    at: string;
}

export interface IAvailability {
    /** Service slugs the item is available on in this country, e.g. "netflix". */
    services: string[];
    links?: Record<string, string>;
    checkedAt: string;
}

/** Media-specific fields for films, series and documentaries. */
export type IVideoDetails = {
    kind: "film" | "show";
    voteCount?: number;
    episodeCount?: number;
    seasonCount?: number;
};

/**
 * One recommendable thing, whatever the medium. Stored in the catalogue table of its media
 * family (films, series and documentaries share the Movies table) and embedded in the vector index.
 */
export interface ICatalogItem {
    /** `<mediaType>:<source>:<sourceId>`, e.g. "movie:tmdb-movie:508442". */
    itemId: string;
    mediaType: EMediaType;
    title: string;
    year?: number;
    /** Minutes: a film's runtime, a series' episode length, an album's play time. */
    runtime?: number;
    genres?: string[];
    primaryGenre?: string;
    /** Content rating by country code, e.g. { ZA: "13" }. */
    rating?: Record<string, string>;
    popularity?: number;
    posterKey?: string;
    /** How the item feels to experience; written once by the catalogue job and embedded. */
    moodDesc?: string;
    embeddedAt?: string;
    /** Where the item can be watched, listened to or read, by country code. */
    availability?: Record<string, IAvailability>;
    why?: Record<string, IWhyEntry>;
    /** Media-specific fields, e.g. IVideoDetails. */
    details?: Record<string, unknown>;
}

/** What the catalogue job writes; the `why` cache is owned by the recommender. */
export type ICatalogItemDraft = Omit<ICatalogItem, "why">;
