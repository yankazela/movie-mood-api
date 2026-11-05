import { IProvider } from "./domain/types";

/** Tunables for the nightly catalog refresh. Environment overrides are read where noted. */
export const DEFAULT_COUNTRIES = ["ZA"];
export const DEFAULT_MAX_PAGES_PER_COUNTRY = 10;
/** Leave headroom under the 15-minute Lambda limit; the job re-invokes itself to continue. */
export const DEFAULT_TIME_BUDGET_MS = 11 * 60 * 1000;
export const TMDB_CONCURRENCY = 4;
export const POSTER_SIZE = "w500";
export const PROVIDER_LOGO_SIZE = "w92";
export const CURSOR_CONFIG_KEY = "CATALOG_CURSOR";

/** Search-page templates per provider slug; `{title}` is replaced with the URL-encoded title. */
export const DEEP_LINK_TEMPLATES: Record<string, string> = {
    "netflix": "https://www.netflix.com/search?q={title}",
    "amazon-prime-video": "https://www.primevideo.com/search/ref=atv_nb_sr?phrase={title}",
    "disney-plus": "https://www.disneyplus.com/search/{title}",
    "apple-tv-plus": "https://tv.apple.com/search?term={title}",
    "apple-tv": "https://tv.apple.com/search?term={title}",
    "showmax": "https://www.showmax.com/eng/search?q={title}",
};

/** Albums per music discovery page: Spotify's maximum for new releases and searches. */
export const MUSIC_PAGE_SIZE = 50;

/**
 * What a music discovery page is: page 1 is the market's new releases; each page after that takes
 * the most relevant tracks of one of these genres in the market and keeps their albums. The order
 * matters because CATALOG_MAX_PAGES caps how many pages a run walks per country.
 */
export const MUSIC_DISCOVER_GENRES = [
    "pop", "hip hop", "r&b", "rock", "indie", "soul", "jazz", "classical", "ambient", "electronic",
    "dance", "folk", "afrobeats", "amapiano", "latin", "country", "metal", "k-pop", "reggae", "blues", "gospel", "soundtrack",
];

/**
 * Service slugs the music catalogue writes in an album's availability. The source only knows
 * Spotify's markets, but an album on Spotify in a market is, as a rule, on the other services
 * there too, so every one of them is written and a user may filter by any of them.
 */
export const MUSIC_SERVICE_SLUGS = ["spotify", "apple-music", "youtube-music", "deezer"];

/** Music services as listed in the Providers table for every country. The ids keep clear of TMDB's. */
export const MUSIC_PROVIDERS: IProvider[] = [
    { id: 9001, slug: "spotify", name: "Spotify", deepLinkTemplate: "https://open.spotify.com/search/{title}" },
    { id: 9002, slug: "apple-music", name: "Apple Music", deepLinkTemplate: "https://music.apple.com/search?term={title}" },
    { id: 9003, slug: "youtube-music", name: "YouTube Music", deepLinkTemplate: "https://music.youtube.com/search?q={title}" },
    { id: 9004, slug: "deezer", name: "Deezer", deepLinkTemplate: "https://www.deezer.com/search/{title}" },
];

export function countriesFromEnvironment(): string[] {
    const raw = process.env.CATALOG_COUNTRIES;
    const countries = (raw ?? "").split(",").map(country => country.trim().toUpperCase()).filter(Boolean);

    return countries.length > 0 ? countries : DEFAULT_COUNTRIES;
}

export function positiveIntFromEnvironment(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);

    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
