export type SpotifyAlbumType = "album" | "single" | "compilation";

/** An album as it appears in listings and search results: enough to decide whether to fetch it. */
export interface SpotifyAlbumRef {
    id: string;
    name: string;
    album_type: SpotifyAlbumType;
}

export interface SpotifyArtistRef {
    id: string;
    name: string;
}

export interface SpotifyImage {
    url: string;
    width: number | null;
    height: number | null;
}

export interface SpotifyTrack {
    id: string;
    name: string;
    duration_ms: number;
    explicit: boolean;
    track_number: number;
}

export interface SpotifyAlbum {
    id: string;
    name: string;
    album_type: SpotifyAlbumType;
    total_tracks: number;
    release_date: string;
    release_date_precision: "year" | "month" | "day";
    /** ISO 3166-1 codes the album may be played in. Absent when the request named a market. */
    available_markets?: string[];
    /** Largest first. */
    images: SpotifyImage[];
    artists: SpotifyArtistRef[];
    /** Usually empty; genres live on artists. */
    genres?: string[];
    label?: string;
    /** 0 to 100. */
    popularity?: number;
    external_urls?: { spotify?: string };
    tracks: { items: SpotifyTrack[]; total: number };
}

export interface SpotifyArtist {
    id: string;
    name: string;
    genres?: string[];
    popularity?: number;
}

export interface SpotifyAlbumPage {
    albums: SpotifyAlbumRef[];
    total: number;
}

export interface SpotifyClient {
    /** The newest releases available in `country`, `limit` at a time from `offset`. */
    newReleases(country: string, limit: number, offset: number): Promise<SpotifyAlbumPage>;

    /** The albums behind the most relevant tracks for `query` in `market`, each album once, most relevant first. */
    searchTrackAlbums(query: string, market: string, limit: number): Promise<SpotifyAlbumRef[]>;

    /** The full album with its tracks and the markets it is available in. */
    getAlbum(id: string): Promise<SpotifyAlbum>;

    /** Artists by id, any number; ids Spotify does not know are left out. */
    getArtists(ids: string[]): Promise<SpotifyArtist[]>;
}
