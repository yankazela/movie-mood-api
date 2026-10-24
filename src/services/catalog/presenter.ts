import { ICatalogItem } from "./domain/items";
import { IRecommendedItem } from "../recommendations/domain/types";

/** The client-facing shape of a catalogue item, with availability and rating narrowed to one country. */
export function toRecommendedItem(item: ICatalogItem, country?: string): IRecommendedItem {
    const code = country?.toUpperCase();

    return {
        itemId: item.itemId,
        mediaType: item.mediaType,
        title: item.title,
        year: item.year,
        runtime: item.runtime,
        genres: item.genres ?? [],
        posterKey: item.posterKey,
        availability: code ? item.availability?.[code] : undefined,
        details: item.details,
        rating: code ? item.rating?.[code] : undefined,
        popularity: item.popularity,
    };
}
