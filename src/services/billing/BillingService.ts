import { IUser } from "../users/domain/types";

/** RevenueCat's webhook body: the event is what matters, the rest is envelope. */
export interface IBillingWebhookEvent {
    type: string;
    /** RevenueCat's id for the event. */
    id?: string;
    app_user_id?: string;
    original_app_user_id?: string;
    aliases?: string[];
    /** Set on TRANSFER events: the ids that lost and gained the subscription. */
    transferred_from?: string[];
    transferred_to?: string[];
    environment?: string;
}

export interface BillingService {
    /**
     * Re-reads the user's entitlement from the billing provider and stores it on the profile, so
     * the next recommendation request is capped by the right plan. Resolves to the profile as the
     * API returns it. Throws NotFoundError when the user has no profile.
     */
    syncUser(userId: string): Promise<IUser>;

    /**
     * Handles a provider webhook by syncing every account the event names. Accounts without a
     * profile are skipped, not failed, so the provider does not keep retrying. Resolves to the ids
     * that were synced. Throws ValidationError when the body is not a webhook event.
     */
    handleWebhook(payload: unknown): Promise<string[]>;
}
