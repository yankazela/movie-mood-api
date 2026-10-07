import { TmdbCountryProviders, TmdbGenre, TmdbProviderRef } from "../TmdbClient";
import { IAvailability } from "../domain/items";
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
