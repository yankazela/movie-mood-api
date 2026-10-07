/** Everything a user can be recommended. Adding a type here is the first step of adding a medium. */
export enum EMediaType {
    MOVIE = "movie",
    SERIES = "series",
    DOCUMENTARY = "documentary",
    MUSIC = "music",
    BOOK = "book",
}

/** Types that share a catalogue table and item shape. */
export enum EMediaFamily {
    VIDEO = "video",
    MUSIC = "music",
    BOOK = "book",
}

export interface IMediaDefinition {
    type: EMediaType;
    family: EMediaFamily;
    /** How prompts and copy refer to one item, e.g. "film". */
    noun: string;
    pluralNoun: string;
}

export const MEDIA_DEFINITIONS: Record<EMediaType, IMediaDefinition> = {
    [EMediaType.MOVIE]: { type: EMediaType.MOVIE, family: EMediaFamily.VIDEO, noun: "film", pluralNoun: "films" },
    [EMediaType.SERIES]: { type: EMediaType.SERIES, family: EMediaFamily.VIDEO, noun: "series", pluralNoun: "series" },
    [EMediaType.DOCUMENTARY]: { type: EMediaType.DOCUMENTARY, family: EMediaFamily.VIDEO, noun: "documentary", pluralNoun: "documentaries" },
    [EMediaType.MUSIC]: { type: EMediaType.MUSIC, family: EMediaFamily.MUSIC, noun: "album", pluralNoun: "albums" },
    [EMediaType.BOOK]: { type: EMediaType.BOOK, family: EMediaFamily.BOOK, noun: "book", pluralNoun: "books" },
};

/**
 * Media types users can request today. Widen this when a catalogue source for a new medium goes
 * live; the API, retrieval filters and defaults all read from it.
 */
export const ACTIVE_MEDIA_TYPES: EMediaType[] = [EMediaType.MOVIE, EMediaType.SERIES, EMediaType.DOCUMENTARY];

export function familyOf(mediaType: EMediaType): EMediaFamily {
    return MEDIA_DEFINITIONS[mediaType].family;
}

export function nounFor(mediaType: EMediaType): string {
    return MEDIA_DEFINITIONS[mediaType].noun;
}

export interface IItemIdParts {
    mediaType: EMediaType;
    /** The catalogue source that owns the id, e.g. "tmdb-movie" or "tmdb-tv". */
    source: string;
    sourceId: string;
}

/** Item ids are `<mediaType>:<source>:<sourceId>`, e.g. "movie:tmdb-movie:508442". */
export function buildItemId(mediaType: EMediaType, source: string, sourceId: string | number): string {
    return `${mediaType}:${source}:${sourceId}`;
}

export function parseItemId(itemId: string): IItemIdParts {
    const [mediaType, source, ...rest] = itemId.split(":");
    const sourceId = rest.join(":");

    if (!isMediaType(mediaType) || !source || !sourceId) {
        throw new Error(`Invalid item id: ${itemId}`);
    }

    return { mediaType, source, sourceId };
}

export function isMediaType(value: unknown): value is EMediaType {
    return typeof value === "string" && (Object.values(EMediaType) as string[]).includes(value);
}
