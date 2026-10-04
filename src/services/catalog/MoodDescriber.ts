export interface IMoodSource {
    movieId: string;
    title: string;
    year?: number;
    genres: string[];
    overview: string;
    keywords: string[];
}

export interface MoodDescriber {
    /** Writes a short description of how each film feels to watch, by movie id. */
    describe(movies: IMoodSource[]): Promise<Map<string, string>>;
}
