/**
 * The app stores a user's choices in its own vocabulary: short streaming ids ("prime"), MPAA-style
 * content ratings ("PG-13") and hyphenated genres ("science-fiction"). The catalogue uses TMDB's:
 * provider slugs ("amazon-prime-video"), per-country certifications and lower-case genre names.
 * These helpers translate the first into the second, and pass anything already in catalogue
 * vocabulary through unchanged.
 */

const SERVICE_ALIASES: Record<string, string[]> = {
    netflix: ["netflix", "netflix-standard-with-ads", "netflix-basic-with-ads"],
    prime: ["amazon-prime-video", "amazon-prime-video-with-ads", "prime-video"],
    disney: ["disney-plus", "disney"],
    apple: ["apple-tv-plus", "apple-tv", "apple-tv-channel"],
    paramount: ["paramount-plus", "paramount", "paramount-plus-apple-tv-channel"],
    crave: ["crave", "crave-starz"],
    max: ["max", "hbo-max"],
};

/** Catalogue provider slugs for the user's chosen services; unknown values are kept as they are. */
export function expandServices(services: string[]): string[] {
    const slugs = services.flatMap(service => SERVICE_ALIASES[service.trim().toLowerCase()] ?? [service.trim().toLowerCase()]);

    return [...new Set(slugs.filter(Boolean))];
}

/** The app service id for a catalogue provider slug, when it is one the app knows. */
export function serviceIdForSlug(slug: string): string | undefined {
    return Object.entries(SERVICE_ALIASES).find(([, slugs]) => slugs.includes(slug))?.[0];
}

type MpaaLevel = "G" | "PG" | "PG-13" | "R";

const MPAA_LEVELS: MpaaLevel[] = ["G", "PG", "PG-13", "R"];

/** Certifications each country uses for each MPAA level, gentlest first. Levels accumulate upwards. */
const CERTIFICATIONS: Record<string, Record<MpaaLevel, string[]>> = {
    US: { G: ["G", "TV-G", "TV-Y", "TV-Y7"], PG: ["PG", "TV-PG"], "PG-13": ["PG-13", "TV-14"], R: ["R", "NC-17", "TV-MA"] },
    CA: { G: ["G", "TV-G", "TV-Y", "TV-Y7", "E"], PG: ["PG", "TV-PG", "8+"], "PG-13": ["13+", "14A", "TV-14", "14+"], R: ["16+", "18A", "R", "18+", "TV-MA", "A"] },
    ZA: { G: ["A", "All", "PG", "7"], PG: ["7-9PG", "10", "10PG", "10-12PG"], "PG-13": ["13", "10-12PG", "13+", "14"], R: ["16", "18", "R18", "X18", "16+", "18+"] },
    GB: { G: ["U", "TV-G", "TV-Y"], PG: ["PG", "TV-PG"], "PG-13": ["12", "12A", "TV-14"], R: ["15", "18", "R18", "TV-MA"] },
    AU: { G: ["G", "TV-G", "C"], PG: ["PG", "TV-PG", "P"], "PG-13": ["M", "MA15+", "TV-14", "MA 15+"], R: ["R18+", "R 18+", "X18+", "TV-MA"] },
    DE: { G: ["0", "6"], PG: ["6", "12"], "PG-13": ["12", "16"], R: ["16", "18"] },
    FR: { G: ["U", "Tous publics"], PG: ["10", "12"], "PG-13": ["12", "16"], R: ["16", "18"] },
    IN: { G: ["U"], PG: ["UA", "U/A", "UA 7+"], "PG-13": ["UA 13+", "UA 16+"], R: ["A", "S"] },
    BR: { G: ["L"], PG: ["10"], "PG-13": ["12", "14"], R: ["16", "18"] },
};

const FALLBACK_COUNTRY = "US";

/**
 * Ratings to match against a country's certifications. MPAA levels in `allowed` stand for that
 * level and everything gentler; anything else is treated as a certification and kept as it is.
 */
export function expandRatings(country: string, allowed: string[]): string[] {
    if (allowed.length === 0) {
        return [];
    }

    const levels = allowed.filter((rating): rating is MpaaLevel => MPAA_LEVELS.includes(rating as MpaaLevel));
    const native = allowed.filter(rating => !MPAA_LEVELS.includes(rating as MpaaLevel));
    const ceiling = Math.max(-1, ...levels.map(level => MPAA_LEVELS.indexOf(level)));
    const table = CERTIFICATIONS[country.toUpperCase()] ?? CERTIFICATIONS[FALLBACK_COUNTRY];
    const mapped = MPAA_LEVELS.slice(0, ceiling + 1).flatMap(level => table[level]);

    return [...new Set([...native, ...mapped])];
}

/** Lower-case, space-separated form of a genre, so "science-fiction" and "Science Fiction" compare equal. */
export function normalizeGenre(genre: string): string {
    return genre.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/** TMDB's television genres combine some film genres; a user who likes one likes the combined genre too. */
const GENRE_ALIASES: Record<string, string[]> = {
    action: ["action & adventure"],
    adventure: ["action & adventure"],
    "science fiction": ["sci-fi & fantasy"],
    fantasy: ["sci-fi & fantasy"],
    war: ["war & politics"],
};

/** Catalogue genre names a user's genre stands for: itself plus any combined television genres. */
export function expandGenres(genres: string[]): string[] {
    const names = genres.flatMap(genre => {
        const normalized = normalizeGenre(genre);

        return [normalized, ...(GENRE_ALIASES[normalized] ?? [])];
    });

    return [...new Set(names)];
}
