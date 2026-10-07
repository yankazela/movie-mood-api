import { ICatalogItem, ICatalogItemDraft, IWhyEntry } from "../domain/items";

export interface CatalogItemRepository {
    /** Fetches the given items; ids that do not exist are simply absent from the result. */
    findByIds(itemIds: string[]): Promise<ICatalogItem[]>;

    /** Writes one entry into the item's `why` map, creating the map if needed. */
    saveWhy(itemId: string, key: string, entry: IWhyEntry): Promise<void>;

    /** Creates or updates the catalogue fields of an item. The `why` cache is left untouched. */
    upsertCatalog(item: ICatalogItemDraft): Promise<void>;
}
