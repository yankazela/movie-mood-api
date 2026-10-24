import { decodeTime } from "ulid";
import { HistoryService, IHistoryEntry, IOutcomeInput } from "./HistoryService";
import { RequestHistoryRepository } from "./RequestHistoryRepository";
import { RequestRepositoryImpl } from "./RequestRepositoryImpl";
import { IRecommendationRequest } from "./domain/types";
import { toRecommendedItem } from "../catalog/presenter";
import { CatalogItemRepository } from "../catalog/store/CatalogItemRepository";
import { CatalogStore } from "../catalog/store/CatalogStore";
import { ICatalogItem } from "../catalog/domain/items";
import { ValidationError } from "../common/errors";
import { UserRepository } from "../users/UserRepository";
import { UserRepositoryImpl } from "../users/UserRepositoryImpl";

export const DEFAULT_HISTORY_LIMIT = 30;
export const MAX_HISTORY_LIMIT = 50;

export class HistoryServiceImpl implements HistoryService {
    private readonly requests: RequestHistoryRepository;
    private readonly catalogStore: CatalogItemRepository;
    private readonly userRepository: UserRepository;

    constructor(
        requests: RequestHistoryRepository = new RequestRepositoryImpl(),
        catalogStore: CatalogItemRepository = CatalogStore.fromEnvironment(),
        userRepository: UserRepository = new UserRepositoryImpl(),
    ) {
        this.requests = requests;
        this.catalogStore = catalogStore;
        this.userRepository = userRepository;
    }

    public async list(userId: string, limit: number = DEFAULT_HISTORY_LIMIT): Promise<IHistoryEntry[]> {
        const bounded = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);
        const requests = await this.requests.listByUser(userId, bounded);

        return this.present(userId, requests);
    }

    public async recordOutcome(userId: string, requestId: string, input: IOutcomeInput): Promise<IHistoryEntry> {
        const updated = await this.requests.recordOutcome(userId, requestedAtOf(requestId), input);
        const [entry] = await this.present(userId, [updated]);

        return entry;
    }

    private async present(userId: string, requests: IRecommendationRequest[]): Promise<IHistoryEntry[]> {
        if (requests.length === 0) {
            return [];
        }

        const [user, items] = await Promise.all([
            this.userRepository.findById(userId),
            this.catalogStore.findByIds(requests.flatMap(request => request.resultIds)),
        ]);
        const byId = new Map<string, ICatalogItem>(items.map(item => [item.itemId, item]));

        return requests.map(request => ({
            requestId: request.requestId,
            requestedAt: request.requestedAt,
            text: request.text,
            objective: request.objective,
            moods: request.moods,
            filters: request.filters,
            moodProfile: request.moodProfile,
            target: request.target,
            results: request.resultIds.flatMap(itemId => {
                const item = byId.get(itemId);

                return item ? [toRecommendedItem(item, user?.country)] : [];
            }),
            selectedItemId: request.selectedItemId,
            feedback: request.feedback,
        }));
    }
}

/** Request ids are ULIDs minted from the request's start time, which is also its sort key. */
export function requestedAtOf(requestId: string): string {
    try {
        return new Date(decodeTime(requestId)).toISOString();
    } catch {
        throw new ValidationError(`${requestId} is not a valid request id`);
    }
}
