import { IQueuedBillingEvent } from "./BillingEventQueue";

/** The webhook's only job: let a genuine RevenueCat event in and queue it. */
export interface BillingWebhookIntake {
    /**
     * Checks the Authorization header against the configured value, makes sure the body is a
     * RevenueCat event and queues it as received. Throws UnauthorizedError when the header does not
     * match and ValidationError when the body is not an event; neither reaches the queue. Resolves
     * to the queued event.
     */
    accept(authorization: string | undefined, body: string | null): Promise<IQueuedBillingEvent>;
}
