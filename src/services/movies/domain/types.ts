/** A cached one-line explanation of why a movie suits a mood, keyed in IMovie.why by `emotion#objective`. */
export interface IWhyEntry {
    text: string;
    model: string;
    at: string;
}

export interface IAvailability {
    services: string[];
    links?: Record<string, string>;
    checkedAt: string;
}

/** Item shape of the Movies table. Partition key: movieId (e.g. "tmdb:508442"). */
export interface IMovie {
    movieId: string;
    title: string;
    year?: number;
    runtime?: number;
    genres?: string[];
    primaryGenre?: string;
    /** Content rating by country code, e.g. { ZA: "PG-13" }. */
    rating?: Record<string, string>;
    popularity?: number;
    voteCount?: number;
    posterKey?: string;
    moodDesc?: string;
    embeddedAt?: string;
    /** Where the movie can be watched, by country code. */
    availability?: Record<string, IAvailability>;
    why?: Record<string, IWhyEntry>;
}
