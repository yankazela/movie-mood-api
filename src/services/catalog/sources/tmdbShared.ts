import { TmdbCountryProviders, TmdbCredits, TmdbGenre, TmdbProviderRef, TmdbTranslation } from "../TmdbClient";
import { IAvailability, ILocalizedText } from "../domain/items";
import { IProvider } from "../domain/types";
import { DEEP_LINK_TEMPLATES } from "../config";

/** TMDB's genre id for Documentary, shared by its film and television genre lists. */
export const TMDB_DOCUMENTARY_GENRE_ID = 99;

export function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function genreNames(genres: TmdbGenre[]): string[] {
    return genres.map(genre => genre.name.toLowerCase());
}

export function isDocumentary(genres: TmdbGenre[]): boolean {
    return genres.some(genre => genre.id === TMDB_DOCUMENTARY_GENRE_ID);
}

const MAX_CAST = 6;

export function castOf(credits: TmdbCredits | undefined): { name: string; character?: string }[] | undefined {
    const cast = [...(credits?.cast ?? [])]
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
        .slice(0, MAX_CAST)
        .map(member => ({ name: member.name, character: member.character || undefined }));

    return cast.length > 0 ? cast : undefined;
}

export function directorOf(credits: TmdbCredits | undefined): string | undefined {
    return credits?.crew?.find(member => member.job === "Director")?.name;
}

export function yearOf(date: string | undefined): number | undefined {
    const year = Number(date?.slice(0, 4));
    return Number.isFinite(year) && year > 0 ? year : undefined;
}

/** Streaming availability for the configured countries, from TMDB's per-country provider lists. */
export function availabilityFor(
    results: Record<string, TmdbCountryProviders> | undefined,
    countries: string[],
    checkedAt: string,
): Record<string, IAvailability> {
    const availability: Record<string, IAvailability> = {};

    for (const country of countries) {
        const flatrate = results?.[country]?.flatrate ?? [];

        if (flatrate.length === 0) {
            continue;
        }

        availability[country] = {
            services: [...new Set(flatrate.map(ref => slugify(ref.provider_name)))],
            links: results?.[country]?.link ? { tmdb: results[country].link as string } : undefined,
            checkedAt,
        };
    }

    return availability;
}

/** Regions whose version of a language is preferred, in order; others follow in TMDB's order. */
const PREFERRED_REGIONS: Record<string, string[]> = {
    fr: ["FR", "CA", "BE", "CH"],
    es: ["ES", "MX", "US", "AR", "CO"],
    pt: ["BR", "PT"],
    de: ["DE", "AT", "CH"],
};

/**
 * Title, tagline and overview for each wanted language. Each field comes from the most preferred
 * regional version that has it, so a missing Spanish-from-Spain overview falls back to the Mexican
 * one. A language with no translated text at all is left out, and the reader falls back to English.
 */
export function localizedTexts(translations: TmdbTranslation[] | undefined, languages: string[]): Record<string, ILocalizedText> | undefined {
    const result: Record<string, ILocalizedText> = {};

    for (const language of languages) {
        const preferred = PREFERRED_REGIONS[language] ?? [language.toUpperCase()];
        const versions = (translations ?? [])
            .filter(translation => translation.iso_639_1 === language)
            .sort((a, b) => rank(preferred, a.iso_3166_1) - rank(preferred, b.iso_3166_1));
        const pick = (field: (data: TmdbTranslation["data"]) => string | undefined) =>
            versions.map(version => field(version.data)?.trim()).find((text): text is string => Boolean(text));
        const text: ILocalizedText = {
            title: pick(data => data.title ?? data.name),
            tagline: pick(data => data.tagline),
            overview: pick(data => data.overview),
        };
        const present = Object.fromEntries(Object.entries(text).filter(([, value]) => value !== undefined)) as ILocalizedText;

        if (Object.keys(present).length > 0) {
            result[language] = present;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

function rank(preferred: string[], region: string): number {
    const index = preferred.indexOf(region);
    return index === -1 ? preferred.length : index;
}

export function providerFrom(ref: TmdbProviderRef, country: string, logoKey: string | undefined): IProvider {
    const slug = slugify(ref.provider_name);

    return {
        id: ref.provider_id,
        slug,
        name: ref.provider_name,
        logoKey,
        deepLinkTemplate: DEEP_LINK_TEMPLATES[slug] ?? `https://www.themoviedb.org/movie/{tmdbId}/watch?locale=${country}`,
    };
}
