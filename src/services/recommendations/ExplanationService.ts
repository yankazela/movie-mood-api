import { EObjective, IMoodProfile } from "./domain/types";
import { ICatalogItem } from "../catalog/domain/items";

export interface ExplanationService {
    /**
     * Returns a one-line "why this" for each item, by item id. Fresh cached lines are reused;
     * missing or stale ones are generated and written back to the item's `why` map.
     */
    explain(items: ICatalogItem[], mood: IMoodProfile, objective: EObjective): Promise<Map<string, string>>;
}
