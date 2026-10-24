import { CatalogBrowseService, IPopularInput, ISearchInput } from "./CatalogBrowseService";
import { CatalogScanner } from "./CatalogScanner";
import { DynamoCatalogScannerImpl } from "./DynamoCatalogScannerImpl";
import { ICatalogItem, IVideoDetails } from "./domain/items";
import { toRecommendedItem } from "./presenter";
import { CatalogItemRepository } from "./store/CatalogItemRepository";
import { CatalogStore } from "./store/CatalogStore";
import { NotFoundError, ValidationError } from "../common/errors";
import { parseItemId } from "../media/MediaType";
import { IRecommendedItem } from "../recommendations/domain/types";
import { expandServices, normalizeGenre } from "../recommendations/preferences";
import { UserRepository } from "../users/UserRepository";
import { UserRepositoryImpl } from "../users/UserRepositoryImpl";

/** The catalogue is small and changes nightly, so a warm Lambda reuses one scan for this long. */
const CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_IDS = 50;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Titles with fewer votes than this are not ranked by audience score; a handful of votes proves nothing. */
const MIN_VOTES_FOR_RATING_SORT = 200;

export class CatalogBrowseServiceImpl implements CatalogBrowseService {
    private readonly scanner: CatalogScanner;
    private readonly catalogStore: CatalogItemRepository;
    private readonly userRepository: UserRepository;
    private readonly now: () => number;
    private cache?: { items: ICatalogItem[]; loadedAt: number };

    constructor(
        scanner: CatalogScanner = new DynamoCatalogScannerImpl(),
        catalogStore: CatalogItemRepository = CatalogStore.fromEnvironment(),
        userRepository: UserRepository = new UserRepositoryImpl(),
        now: () => number = Date.now,
    ) {
        this.scanner = scanner;
        this.catalogStore = catalogStore;
        this.userRepository = userRepository;
        this.now = now;
    }

    public async get(userId: string, itemId: string, country?: string): Promise<IRecommendedItem> {
        const [item] = await this.getMany(userId, [itemId], country);

        if (!item) {
            throw new NotFoundError(`No catalogue item ${itemId}`);
        }

        return item;
    }

    public async getMany(userId: string, itemIds: string[], country?: string): Promise<IRecommendedItem[]> {
        const unique = [...new Set(itemIds)];

        if (unique.length > MAX_IDS) {
            throw new ValidationError(`Ask for at most ${MAX_IDS} items at a time`);
        }

        for (const itemId of unique) {
            try {
                parseItemId(itemId);
            } catch {
                throw new ValidationError(`${itemId} is not a valid item id`);
            }
        }

        if (unique.length === 0) {
            return [];
        }

        const [code, items] = await Promise.all([this.countryFor(userId, country), this.catalogStore.findByIds(unique)]);
        const byId = new Map(items.map(item => [item.itemId, item]));

        return unique.flatMap(itemId => {
            const item = byId.get(itemId);

            return item ? [toRecommendedItem(item, code)] : [];
        });
    }

    public async search(userId: string, input: ISearchInput, country?: string): Promise<IRecommendedItem[]> {
        const query = normalize(input.query);

        if (!query) {
            return [];
        }

        const [code, catalogue] = await Promise.all([this.countryFor(userId, country), this.catalogue()]);

        return catalogue
            .filter(item => matchesMedia(item, input.mediaTypes) && streamsIn(item, code))
            .map(item => ({ item, score: searchScore(item, query) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => b.score - a.score || (b.item.popularity ?? 0) - (a.item.popularity ?? 0))
            .slice(0, limitOf(input.limit))
            .map(entry => toRecommendedItem(entry.item, code));
    }

    public async popular(userId: string, input: IPopularInput, country?: string): Promise<IRecommendedItem[]> {
        const [code, catalogue] = await Promise.all([this.countryFor(userId, country), this.catalogue()]);
        const services = expandServices(input.services ?? []);
        const byRating = input.sort === "rating";

        return catalogue
            .filter(item => matchesMedia(item, input.mediaTypes) && streamsIn(item, code, services))
            .filter(item => !byRating || (audienceScore(item) !== undefined && voteCount(item) >= MIN_VOTES_FOR_RATING_SORT))
            .sort((a, b) => byRating
                ? (audienceScore(b) ?? 0) - (audienceScore(a) ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0)
                : (b.popularity ?? 0) - (a.popularity ?? 0))
            .slice(0, limitOf(input.limit))
            .map(item => toRecommendedItem(item, code));
    }

    private async catalogue(): Promise<ICatalogItem[]> {
        if (!this.cache || this.now() - this.cache.loadedAt > CACHE_TTL_MS) {
            this.cache = { items: await this.scanner.scanVideo(), loadedAt: this.now() };
        }

        return this.cache.items;
    }

    /** An explicit country wins; otherwise the profile's. Undefined when neither is known. */
    private async countryFor(userId: string, country?: string): Promise<string | undefined> {
        if (country) {
            return country.toUpperCase();
        }

        return (await this.userRepository.findById(userId))?.country?.toUpperCase();
    }
}

function normalize(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function limitOf(limit: number | undefined): number {
    return Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT), MAX_LIMIT);
}

function matchesMedia(item: ICatalogItem, mediaTypes: ISearchInput["mediaTypes"]): boolean {
    return !mediaTypes?.length || mediaTypes.includes(item.mediaType);
}

/** True when the item streams in `country` (on one of `services`, when given). Always true with no country. */
function streamsIn(item: ICatalogItem, country: string | undefined, services: string[] = []): boolean {
    if (!country) {
        return true;
    }

    const available = item.availability?.[country];

    if (!available || available.services.length === 0) {
        return false;
    }

    return services.length === 0 || available.services.some(service => services.includes(service));
}

function detailsOf(item: ICatalogItem): Partial<IVideoDetails> {
    return (item.details ?? {}) as Partial<IVideoDetails>;
}

function audienceScore(item: ICatalogItem): number | undefined {
    const score = detailsOf(item).voteAverage;

    return typeof score === "number" && score > 0 ? score : undefined;
}

function voteCount(item: ICatalogItem): number {
    return detailsOf(item).voteCount ?? 0;
}

/** 0 when the item does not match. Titles outrank people, who outrank genres. */
export function searchScore(item: ICatalogItem, query: string): number {
    const title = normalize(item.title);
    const tokens = query.split(" ");

    if (title === query) return 100;
    if (title.startsWith(query)) return 80;
    if (title.includes(query)) return 60;
    if (tokens.length > 1 && tokens.every(token => title.includes(token))) return 50;

    const details = detailsOf(item);
    const people = [details.director, ...(details.cast ?? []).map(member => member.name)].filter((name): name is string => Boolean(name));

    if (people.some(name => normalize(name).includes(query))) return 40;
    if ((item.genres ?? []).some(genre => normalizeGenre(genre).includes(normalizeGenre(query)))) return 20;

    return 0;
}
