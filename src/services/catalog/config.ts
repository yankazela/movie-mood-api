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

export function countriesFromEnvironment(): string[] {
    const raw = process.env.CATALOG_COUNTRIES;
    const countries = (raw ?? "").split(",").map(country => country.trim().toUpperCase()).filter(Boolean);

    return countries.length > 0 ? countries : DEFAULT_COUNTRIES;
}

export function positiveIntFromEnvironment(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);

    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
