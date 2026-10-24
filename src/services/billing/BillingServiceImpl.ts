import { BillingService, IBillingWebhookEvent } from "./BillingService";
import { EntitlementProvider } from "./EntitlementProvider";
import { RevenueCatClientImpl } from "./RevenueCatClientImpl";
import { NotFoundError, ValidationError } from "../common/errors";
import { UserRepository } from "../users/UserRepository";
import { UserRepositoryImpl } from "../users/UserRepositoryImpl";
import { UserService } from "../users/UserService";
import { UserServiceImpl } from "../users/UserServiceImpl";
import { IUser } from "../users/domain/types";

/** Ids RevenueCat makes up before the app signs the user in; they never match a profile. */
const ANONYMOUS_ID_PREFIX = "$RCAnonymousID:";

export class BillingServiceImpl implements BillingService {
    private readonly entitlements: EntitlementProvider;
    private readonly userRepository: UserRepository;
    private readonly userService: UserService;

    constructor(
        entitlements: EntitlementProvider = RevenueCatClientImpl.fromSecret(),
        userRepository: UserRepository = new UserRepositoryImpl(),
        userService: UserService = new UserServiceImpl(undefined, userRepository),
    ) {
        this.entitlements = entitlements;
        this.userRepository = userRepository;
        this.userService = userService;
    }

    public async syncUser(userId: string): Promise<IUser> {
        const entitlement = await this.entitlements.fetchEntitlement(userId);

        await this.userRepository.setPlan(userId, entitlement, new Date().toISOString());

        return this.userService.getUser(userId);
    }

    public async handleWebhook(payload: unknown): Promise<string[]> {
        const event = parseBillingWebhook(payload);

        // The dashboard's test event names no real account.
        if (event.type === "TEST") {
            return [];
        }

        const synced: string[] = [];

        for (const userId of accountIds(event)) {
            try {
                await this.syncUser(userId);
                synced.push(userId);
            } catch (error) {
                if (error instanceof NotFoundError) {
                    console.warn(`Billing event ${event.type} names ${userId}, who has no profile; skipped`);
                    continue;
                }

                throw error;
            }
        }

        return synced;
    }
}

/** The event inside a RevenueCat webhook body. Throws ValidationError when the body is not one. */
export function parseBillingWebhook(payload: unknown): IBillingWebhookEvent {
    const event = (payload as { event?: unknown } | null)?.event;

    if (typeof event !== "object" || event === null || typeof (event as IBillingWebhookEvent).type !== "string") {
        throw new ValidationError("Request body must be a RevenueCat webhook event");
    }

    return event as IBillingWebhookEvent;
}

/** Every account the event could have changed, deduplicated, without the provider's anonymous ids. */
export function accountIds(event: IBillingWebhookEvent): string[] {
    const candidates = [
        event.app_user_id,
        event.original_app_user_id,
        ...(event.aliases ?? []),
        ...(event.transferred_from ?? []),
        ...(event.transferred_to ?? []),
    ];

    return [...new Set(candidates.filter((id): id is string => typeof id === "string" && id.trim() !== "" && !id.startsWith(ANONYMOUS_ID_PREFIX)))];
}
