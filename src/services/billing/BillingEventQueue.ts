/** A webhook event as it travels through the queue: the raw body, plus what helps find it again later. */
export interface IQueuedBillingEvent {
    /** The webhook body exactly as received, so the processor sees what RevenueCat sent. */
    body: string;
    /** RevenueCat's event type, e.g. INITIAL_PURCHASE. */
    type: string;
    /** RevenueCat's event id, when it sent one. */
    eventId?: string;
    /** SANDBOX or PRODUCTION. */
    environment?: string;
    /** When the webhook received it (ISO 8601). */
    receivedAt: string;
}

/** Hands webhook events to the processor, which runs them later and independently of the webhook call. */
export interface BillingEventQueue {
    /** Resolves once the queue has the event. */
    enqueue(event: IQueuedBillingEvent): Promise<void>;
}
