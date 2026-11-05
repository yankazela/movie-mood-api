import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SpotifyAlbum, SpotifyAlbumPage, SpotifyAlbumRef, SpotifyArtist, SpotifyClient } from "./SpotifyClient";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const BASE_URL = "https://api.spotify.com/v1";
const MAX_ATTEMPTS = 3;
/** A token is renewed this long before Spotify says it expires. */
const TOKEN_MARGIN_MS = 60 * 1000;
/** Spotify's maximum for one artists call. */
const ARTISTS_PER_CALL = 50;

export interface SpotifyCredentials {
    clientId: string;
    clientSecret: string;
}

/**
 * Spotify Web API over plain fetch, with the client-credentials flow: the catalogue job acts as
 * itself, not as a user, which is all browsing and album metadata need.
 */
export class SpotifyClientImpl implements SpotifyClient {
    private readonly credentials: SpotifyCredentials;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private token?: { value: string; expiresAt: number };

    constructor(credentials: SpotifyCredentials, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
        this.credentials = credentials;
        this.fetchImpl = fetchImpl;
        this.now = now;
    }

    /**
     * Reads the client id and secret from Secrets Manager (JSON with `clientId` and `clientSecret`).
     * Resolves to null when no secret is configured or it is still empty, so the music source stays off.
     */
    public static async fromSecret(
        secretId: string = process.env.SPOTIFY_SECRET_ARN || "",
        client: SecretsManagerClient = new SecretsManagerClient({}),
    ): Promise<SpotifyClientImpl | null> {
        if (!secretId) {
            return null;
        }

        const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        const credentials = parseCredentials(result.SecretString ?? "");

        return credentials ? new SpotifyClientImpl(credentials) : null;
    }

    public async newReleases(country: string, limit: number, offset: number): Promise<SpotifyAlbumPage> {
        const data = await this.get<{ albums: { items: SpotifyAlbumRef[]; total: number } }>("/browse/new-releases", {
            country,
            limit: String(limit),
            offset: String(offset),
        });

        return { albums: (data.albums?.items ?? []).map(albumRef), total: data.albums?.total ?? 0 };
    }

    public async searchTrackAlbums(query: string, market: string, limit: number): Promise<SpotifyAlbumRef[]> {
        const data = await this.get<{ tracks: { items: { album: SpotifyAlbumRef }[] } }>("/search", {
            q: query,
            type: "track",
            market,
            limit: String(limit),
        });
        const seen = new Set<string>();
        const albums: SpotifyAlbumRef[] = [];

        for (const track of data.tracks?.items ?? []) {
            if (track.album && !seen.has(track.album.id)) {
                seen.add(track.album.id);
                albums.push(albumRef(track.album));
            }
        }

        return albums;
    }

    public getAlbum(id: string): Promise<SpotifyAlbum> {
        // No market parameter: with one, Spotify leaves available_markets out of the answer.
        return this.get<SpotifyAlbum>(`/albums/${encodeURIComponent(id)}`, {});
    }

    public async getArtists(ids: string[]): Promise<SpotifyArtist[]> {
        const artists: SpotifyArtist[] = [];

        for (let start = 0; start < ids.length; start += ARTISTS_PER_CALL) {
            const chunk = ids.slice(start, start + ARTISTS_PER_CALL);
            const data = await this.get<{ artists: (SpotifyArtist | null)[] }>("/artists", { ids: chunk.join(",") });

            artists.push(...(data.artists ?? []).filter((artist): artist is SpotifyArtist => artist !== null));
        }

        return artists;
    }

    private async get<T>(path: string, params: Record<string, string>): Promise<T> {
        const url = new URL(`${BASE_URL}${path}`);

        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        for (let attempt = 1; ; attempt++) {
            const response = await this.fetchImpl(url, { headers: { accept: "application/json", authorization: `Bearer ${await this.accessToken()}` } });

            if (response.ok) {
                return (await response.json()) as T;
            }

            // An expired or revoked token: fetch a fresh one and try once more.
            if (response.status === 401 && attempt < MAX_ATTEMPTS) {
                this.token = undefined;
                continue;
            }

            const retryable = response.status === 429 || response.status >= 500;

            if (!retryable || attempt >= MAX_ATTEMPTS) {
                throw new Error(`Spotify responded ${response.status} for ${path}`);
            }

            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
        }
    }

    private async accessToken(): Promise<string> {
        if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now()) {
            return this.token.value;
        }

        const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
        const response = await this.fetchImpl(TOKEN_URL, {
            method: "POST",
            headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=client_credentials",
        });

        if (!response.ok) {
            throw new Error(`Spotify token request failed with ${response.status}`);
        }

        const data = (await response.json()) as { access_token: string; expires_in: number };

        this.token = { value: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };

        return this.token.value;
    }
}

/** The JSON a secret holds: `clientId` and `clientSecret`. Null unless both are present. */
export function parseCredentials(raw: string): SpotifyCredentials | null {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const clientId = parsed.clientId ?? parsed.client_id;
        const clientSecret = parsed.clientSecret ?? parsed.client_secret;

        if (typeof clientId === "string" && clientId.trim() && typeof clientSecret === "string" && clientSecret.trim()) {
            return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
        }
    } catch {
        // Not JSON: there is no credential to use.
    }

    return null;
}

function albumRef(album: SpotifyAlbumRef): SpotifyAlbumRef {
    return { id: album.id, name: album.name, album_type: album.album_type };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
