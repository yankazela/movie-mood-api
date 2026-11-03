import { ICatalogItem } from "./domain/items";
import { requestLocale } from "../i18n/locale";
import { IRecommendedItem } from "../recommendations/domain/types";

/**
 * The client-facing shape of a catalogue item, with availability and rating narrowed to one country
 * and text in the caller's language where the catalogue has it (English otherwise). `originalTitle`
 * keeps the catalogue title when a translated one is shown, so the client can still search or match on it.
 */
export function toRecommendedItem(item: ICatalogItem, country?: string, locale: string = requestLocale()): IRecommendedItem {
    const code = country?.toUpperCase();
    const text = locale !== "en" ? item.i18n?.[locale] : undefined;
    const details = text && item.details
        ? { ...item.details, ...(text.overview ? { overview: text.overview } : {}), ...(text.tagline ? { tagline: text.tagline } : {}) }
        : item.details;

    return {
        itemId: item.itemId,
        mediaType: item.mediaType,
        title: text?.title ?? item.title,
        originalTitle: text?.title && text.title !== item.title ? item.title : undefined,
        language: text ? locale : "en",
        year: item.year,
        runtime: item.runtime,
        genres: item.genres ?? [],
        posterKey: item.posterKey,
        availability: code ? item.availability?.[code] : undefined,
        details,
        rating: code ? item.rating?.[code] : undefined,
        popularity: item.popularity,
    };
}
