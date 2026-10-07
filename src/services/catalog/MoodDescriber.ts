import { EMediaType } from "../media/MediaType";

export interface IMoodSource {
    itemId: string;
    mediaType: EMediaType;
    title: string;
    year?: number;
    genres: string[];
    overview: string;
    keywords: string[];
}

export interface MoodDescriber {
    /** Writes a short description of how each item feels to experience, by item id. */
    describe(movies: IMoodSource[]): Promise<Map<string, string>>;
}
