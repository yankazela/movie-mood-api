import { BillingService } from "./BillingService";

/** What the processor needs from a queue record. */
export interface IQueuedRecord {
    messageId: string;
    body: string;
}

/**
 * Runs each queued webhook event through the billing service. A record that fails is reported
 * back by id so the queue redelivers just that one; once the queue's retry budget is spent it
 * lands in the dead-letter queue with its payload. Replaying is safe: processing re-reads the
 * subscriber from RevenueCat rather than applying the event itself. Resolves to the ids that failed.
 */
export async function processBillingRecords(
    records: IQueuedRecord[],
    billing: BillingService,
    logger: Pick<Console, "info" | "error"> = console,
): Promise<string[]> {
    const failed: string[] = [];

    for (const record of records) {
        try {
            const synced = await billing.handleWebhook(JSON.parse(record.body));

            logger.info(`Billing event ${record.messageId} processed; synced ${synced.length > 0 ? synced.join(", ") : "nobody"}`);
        } catch (error: any) {
            logger.error(`Billing event ${record.messageId} failed: ${error?.message ?? error}`);
            failed.push(record.messageId);
        }
    }

    return failed;
}
