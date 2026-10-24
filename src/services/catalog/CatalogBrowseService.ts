import { IRecommendedItem } from "../recommendations/domain/types";
import { EMediaType } from "../media/MediaType";

export type PopularSort = "popularity" | "rating";

export interface ISearchInput {
    query: string;
    mediaTypes?: EMediaType[];
    limit?: number;
}

export interface IPopularInput {
    mediaTypes?: EMediaType[];
    /** The user's own service ids; only titles on one of them are listed. */
    services?: string[];
    sort?: PopularSort;
    limit?: number;
}

/**
 * Looking things up in the catalogue outside a recommendation: by id, by search, or by popularity.
 * Availability and ratings are narrowed to `country`, which defaults to the user's profile country.
 * When a country is known, only titles streaming there are listed by search and popular.
 */
export interface CatalogBrowseService {
    /** Throws NotFoundError when the item is not in the catalogue. */
    get(userId: string, itemId: string, country?: string): Promise<IRecommendedItem>;

    /** In the order asked for; ids no longer in the catalogue are left out. */
    getMany(userId: string, itemIds: string[], country?: string): Promise<IRecommendedItem[]>;

    search(userId: string, input: ISearchInput, country?: string): Promise<IRecommendedItem[]>;

    popular(userId: string, input: IPopularInput, country?: string): Promise<IRecommendedItem[]>;
}
