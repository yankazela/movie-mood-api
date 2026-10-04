import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { TmdbClient, TmdbDiscoverPage, TmdbMovieDetails, TmdbProviderRef } from "./TmdbClient";

const BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const MAX_ATTEMPTS = 3;

/** TMDB v3 over plain fetch. Accepts either a v3 API key or a v4 read access token. */
export class TmdbClientImpl implements TmdbClient {
    private readonly credential: string;
    private readonly fetchImpl: typeof fetch;

    constructor(credential: string, fetchImpl: typeof fetch = fetch) {
        this.credential = credential;
        this.fetchImpl = fetchImpl;
    }

    /** Reads the credential from Secrets Manager. The secret holds the raw key, or JSON with `apiKey`. */
    public static async fromSecret(
        secretId: string = process.env.TMDB_SECRET_ARN || "",
        client: SecretsManagerClient = new SecretsManagerClient({}),
    ): Promise<TmdbClientImpl> {
        const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        const credential = parseCredential((result.SecretString ?? "").trim());

        if (!credential || credential === "replace-me") {
            throw new Error(`TMDB credential is not set in secret ${secretId}`);
        }

        return new TmdbClientImpl(credential);
    }

    public async discoverMovies(country: string, page: number): Promise<TmdbDiscoverPage> {
        const data = await this.get<{ page: number; total_pages: number; results: { id: number; title: string }[] }>(
            "/discover/movie",
            {
                watch_region: country,
                with_watch_monetization_types: "flatrate",
                sort_by: "popularity.desc",
                include_adult: "false",
                include_video: "false",
                page: String(page),
            },
        );

        return {
            page: data.page,
            totalPages: data.total_pages,
            results: data.results.map(movie => ({ id: movie.id, title: movie.title })),
        };
    }

    public getMovie(tmdbId: number): Promise<TmdbMovieDetails> {
        return this.get<TmdbMovieDetails>(`/movie/${tmdbId}`, {
            append_to_response: "release_dates,watch/providers,keywords",
        });
    }

    public async listProviders(country: string): Promise<TmdbProviderRef[]> {
        const data = await this.get<{ results: TmdbProviderRef[] }>("/watch/providers/movie", { watch_region: country });

        return data.results ?? [];
    }

    public imageUrl(path: string, size: string): string {
        return `${IMAGE_BASE_URL}/${size}${path}`;
    }

    private async get<T>(path: string, params: Record<string, string>): Promise<T> {
        const url = new URL(`${BASE_URL}${path}`);
        const headers: Record<string, string> = { accept: "application/json" };

        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        // v4 read access tokens are JWTs and go in the header; v3 keys go in the query string.
        if (this.credential.startsWith("eyJ")) {
            headers.authorization = `Bearer ${this.credential}`;
        } else {
            url.searchParams.set("api_key", this.credential);
        }

        for (let attempt = 1; ; attempt++) {
            const response = await this.fetchImpl(url, { headers });

            if (response.ok) {
                return (await response.json()) as T;
            }

            const retryable = response.status === 429 || response.status >= 500;

            if (!retryable || attempt >= MAX_ATTEMPTS) {
                throw new Error(`TMDB responded ${response.status} for ${path}`);
            }

            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
        }
    }
}

function parseCredential(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const candidate = parsed.readAccessToken ?? parsed.apiKey ?? parsed.api_key ?? parsed.token;

        return typeof candidate === "string" ? candidate : raw;
    } catch {
        return raw;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
