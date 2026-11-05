import { CatalogSource, ICatalogDraft, ICatalogPage, ICatalogRef } from "./CatalogSource";
import { yearOf } from "./tmdbShared";
import { SpotifyAlbum, SpotifyClient, SpotifyTrack } from "../SpotifyClient";
import { MUSIC_DISCOVER_GENRES, MUSIC_PAGE_SIZE, MUSIC_PROVIDERS, MUSIC_SERVICE_SLUGS } from "../config";
import { IAvailability, IMusicDetails } from "../domain/items";
import { IProvider } from "../domain/types";
import { EMediaType, buildItemId } from "../../media/MediaType";

export const SPOTIFY_ALBUM_SOURCE_ID = "spotify-album";
/** Track titles kept on an item; enough for a details page without bloating the record. */
const MAX_TRACKS = 30;
/** Track titles the mood describer sees. */
const DESCRIBED_TRACKS = 8;

/**
 * Albums from Spotify. Discovery walks the market's new releases, then the albums behind the most
 * relevant tracks of each genre in MUSIC_DISCOVER_GENRES. Singles are skipped: a recommendation
 * is an album's worth of listening. Availability comes from the album's markets and is written for
 * every major music service, see MUSIC_SERVICE_SLUGS.
 */
export class SpotifyAlbumSource implements CatalogSource {
    public readonly id = SPOTIFY_ALBUM_SOURCE_ID;

    private readonly spotify: SpotifyClient;
    private readonly genres: string[];
    private readonly pageSize: number;
    /** Artist genres looked up so far; artists recur across albums of one run. */
    private readonly artistGenres = new Map<string, string[]>();

    constructor(spotify: SpotifyClient, genres: string[] = MUSIC_DISCOVER_GENRES, pageSize: number = MUSIC_PAGE_SIZE) {
        this.spotify = spotify;
        this.genres = genres;
        this.pageSize = pageSize;
    }

    public async discover(country: string, page: number): Promise<ICatalogPage> {
        const totalPages = 1 + this.genres.length;

        if (page < 1 || page > totalPages) {
            return { refs: [], totalPages };
        }

        const albums = page === 1
            ? (await this.spotify.newReleases(country, this.pageSize, 0)).albums
            : await this.spotify.searchTrackAlbums(`genre:"${this.genres[page - 2]}"`, country, this.pageSize);

        return {
            refs: albums.filter(album => album.album_type !== "single").map(album => ({ sourceId: album.id })),
            totalPages,
        };
    }

    public async fetch(ref: ICatalogRef, countries: string[], checkedAt: string): Promise<ICatalogDraft | null> {
        const album = await this.spotify.getAlbum(ref.sourceId);

        if (album.album_type === "single") {
            return null;
        }

        const itemId = buildItemId(EMediaType.MUSIC, this.id, album.id);
        const artists = album.artists.map(artist => artist.name);
        const genres = await this.genresOf(album);
        const tracks = album.tracks?.items ?? [];
        const year = yearOf(album.release_date);
        const runtime = Math.round(tracks.reduce((sum, track) => sum + (track.duration_ms ?? 0), 0) / 60_000) || undefined;
        const url = album.external_urls?.spotify;
        const image = album.images?.[0]?.url;
        const details: IMusicDetails = {
            kind: "album",
            artist: artists.join(", "),
            artists,
            albumType: album.album_type,
            trackCount: album.total_tracks,
            tracks: tracks.map(track => track.name).slice(0, MAX_TRACKS),
            label: album.label || undefined,
            explicit: tracks.some(track => track.explicit),
            url,
        };

        return {
            item: {
                itemId,
                mediaType: EMediaType.MUSIC,
                title: album.name,
                year,
                runtime,
                genres,
                primaryGenre: genres[0],
                popularity: album.popularity,
                posterKey: image ? `posters/${this.id}-${album.id}.jpg` : undefined,
                availability: musicAvailability(album.available_markets, countries, checkedAt, url),
                details,
            },
            moodSource: {
                itemId,
                mediaType: EMediaType.MUSIC,
                title: album.name,
                year,
                genres,
                overview: describeAlbum(album, artists, tracks),
                keywords: genres,
            },
            imageUrl: image,
        };
    }

    /** The same services everywhere: the catalogue does not know which ones operate in a country. */
    public async listProviders(): Promise<IProvider[]> {
        return MUSIC_PROVIDERS.map(provider => ({ ...provider }));
    }

    /** The album's own genres, then its artists'; Spotify rarely fills the former. */
    private async genresOf(album: SpotifyAlbum): Promise<string[]> {
        const missing = album.artists.map(artist => artist.id).filter(id => id && !this.artistGenres.has(id));

        if (missing.length > 0) {
            for (const artist of await this.spotify.getArtists(missing)) {
                this.artistGenres.set(artist.id, artist.genres ?? []);
            }
        }

        const names = [...(album.genres ?? []), ...album.artists.flatMap(artist => this.artistGenres.get(artist.id) ?? [])];

        return [...new Set(names.map(name => name.trim().toLowerCase()).filter(Boolean))];
    }
}

/**
 * Availability for the configured countries that are among the album's markets. No market list
 * means the album plays everywhere. Every music service is written, see MUSIC_SERVICE_SLUGS; the
 * only direct link is the source's.
 */
export function musicAvailability(markets: string[] | undefined, countries: string[], checkedAt: string, url?: string): Record<string, IAvailability> {
    const available = markets ? new Set(markets.map(market => market.toUpperCase())) : undefined;
    const availability: Record<string, IAvailability> = {};

    for (const country of countries) {
        if (!available || available.has(country)) {
            availability[country] = { services: [...MUSIC_SERVICE_SLUGS], links: url ? { spotify: url } : undefined, checkedAt };
        }
    }

    return availability;
}

/** Spotify has no blurb for an album, so the mood describer gets the facts: who, when, what kind, and the opening tracks. */
export function describeAlbum(album: SpotifyAlbum, artists: string[], tracks: SpotifyTrack[]): string {
    const kind = album.album_type === "compilation" ? "compilation" : "album";
    const year = yearOf(album.release_date);
    const parts = [
        `${album.name} is a ${year ? `${year} ` : ""}${kind} by ${artists.join(", ") || "an unknown artist"}` +
        `${album.label ? ` on ${album.label}` : ""}, with ${album.total_tracks} tracks.`,
    ];

    if (tracks.length > 0) {
        parts.push(`Tracks include ${tracks.slice(0, DESCRIBED_TRACKS).map(track => track.name).join(", ")}.`);
    }

    return parts.join(" ");
}
