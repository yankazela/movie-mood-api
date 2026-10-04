export interface TmdbMovieSummary {
    id: number;
    title: string;
}

export interface TmdbDiscoverPage {
    page: number;
    totalPages: number;
    results: TmdbMovieSummary[];
}

export interface TmdbGenre {
    id: number;
    name: string;
}

export interface TmdbProviderRef {
    provider_id: number;
    provider_name: string;
    logo_path: string | null;
    display_priority?: number;
}

export interface TmdbCountryProviders {
    link?: string;
    flatrate?: TmdbProviderRef[];
}

export interface TmdbReleaseDateEntry {
    iso_3166_1: string;
    release_dates: { certification: string; type: number }[];
}

export interface TmdbMovieDetails {
    id: number;
    title: string;
    overview: string;
    release_date?: string;
    runtime?: number | null;
    genres: TmdbGenre[];
    popularity: number;
    vote_count: number;
    poster_path: string | null;
    keywords?: { keywords: { name: string }[] };
    release_dates?: { results: TmdbReleaseDateEntry[] };
    "watch/providers"?: { results: Record<string, TmdbCountryProviders> };
}

export interface TmdbClient {
    /** Movies streamable in `country`, most popular first, twenty per page. */
    discoverMovies(country: string, page: number): Promise<TmdbDiscoverPage>;

    /** Full details including certifications, watch providers for every country, and keywords. */
    getMovie(tmdbId: number): Promise<TmdbMovieDetails>;

    listProviders(country: string): Promise<TmdbProviderRef[]>;

    imageUrl(path: string, size: string): string;
}
