import { ICatalogItemDraft } from "../domain/items";
import { IProvider } from "../domain/types";
import { IMoodSource } from "../MoodDescriber";

/** A reference to an item in its source's own id space. */
export interface ICatalogRef {
    sourceId: string;
}

export interface ICatalogPage {
    refs: ICatalogRef[];
    totalPages: number;
}

/** Everything the catalogue job needs to store one item, as produced by a source. */
export interface ICatalogDraft {
    item: ICatalogItemDraft;
    /** Input for the mood description, only used when the item has none yet. */
    moodSource: IMoodSource;
    /** Where to download the poster or cover from; stored under item.posterKey. */
    imageUrl?: string;
}

/**
 * A place items come from: TMDB films, TMDB television, and later a music and a book API.
 * The refresh job knows nothing about any of them beyond this interface; register a new
 * source in CatalogRefreshServiceImpl.create() to add a medium.
 */
export interface CatalogSource {
    /** Stable id used in item ids and the cursor, e.g. "tmdb-movie". */
    readonly id: string;

    /** Popular items available in `country`, most popular first. */
    discover(country: string, page: number): Promise<ICatalogPage>;

    /** The full item, with availability and ratings limited to `countries`. Null to skip it. */
    fetch(ref: ICatalogRef, countries: string[], checkedAt: string): Promise<ICatalogDraft | null>;

    /** Providers for a country, when the medium has them (streaming services, music services, bookshops). */
    listProviders?(country: string): Promise<IProvider[]>;
}
