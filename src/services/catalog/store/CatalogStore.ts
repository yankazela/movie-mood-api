import { CatalogItemRepository } from "./CatalogItemRepository";
import { DynamoCatalogItemRepositoryImpl } from "./DynamoCatalogItemRepositoryImpl";
import { ICatalogItem, ICatalogItemDraft, IWhyEntry } from "../domain/items";
import { EMediaFamily, familyOf, parseItemId } from "../../media/MediaType";

/**
 * Routes catalogue reads and writes to the table of each item's media family. Films, series and
 * documentaries live in the Movies table; music and books get their own tables when they arrive,
 * registered here through MUSIC_TABLE_NAME and BOOKS_TABLE_NAME.
 */
export class CatalogStore implements CatalogItemRepository {
    private readonly byFamily: Partial<Record<EMediaFamily, CatalogItemRepository>>;

    constructor(byFamily: Partial<Record<EMediaFamily, CatalogItemRepository>>) {
        this.byFamily = byFamily;
    }

    public static fromEnvironment(): CatalogStore {
        const documentClient = DynamoCatalogItemRepositoryImpl.defaultDocumentClient();
        const byFamily: Partial<Record<EMediaFamily, CatalogItemRepository>> = {};

        if (process.env.MOVIES_TABLE_NAME) {
            byFamily[EMediaFamily.VIDEO] = new DynamoCatalogItemRepositoryImpl(documentClient, process.env.MOVIES_TABLE_NAME, "movieId");
        }

        if (process.env.MUSIC_TABLE_NAME) {
            byFamily[EMediaFamily.MUSIC] = new DynamoCatalogItemRepositoryImpl(documentClient, process.env.MUSIC_TABLE_NAME);
        }

        if (process.env.BOOKS_TABLE_NAME) {
            byFamily[EMediaFamily.BOOK] = new DynamoCatalogItemRepositoryImpl(documentClient, process.env.BOOKS_TABLE_NAME);
        }

        return new CatalogStore(byFamily);
    }

    public async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        const grouped = new Map<EMediaFamily, string[]>();

        for (const itemId of itemIds) {
            const family = familyOf(parseItemId(itemId).mediaType);
            grouped.set(family, [...(grouped.get(family) ?? []), itemId]);
        }

        const results = await Promise.all(
            [...grouped].map(([family, ids]) => this.repositoryFor(family).findByIds(ids)),
        );

        return results.flat();
    }

    public saveWhy(itemId: string, key: string, entry: IWhyEntry): Promise<void> {
        return this.repositoryFor(familyOf(parseItemId(itemId).mediaType)).saveWhy(itemId, key, entry);
    }

    public upsertCatalog(item: ICatalogItemDraft): Promise<void> {
        return this.repositoryFor(familyOf(item.mediaType)).upsertCatalog(item);
    }

    private repositoryFor(family: EMediaFamily): CatalogItemRepository {
        const repository = this.byFamily[family];

        if (!repository) {
            throw new Error(`No catalogue table is configured for ${family} items`);
        }

        return repository;
    }
}
