import { ICatalogItem } from "./domain/items";

/** Reads whole catalogue tables, for features that search or rank across every item. */
export interface CatalogScanner {
    /** Every film, series and documentary, without the mood description and "why" caches. */
    scanVideo(): Promise<ICatalogItem[]>;
}
