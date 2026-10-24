import { timingSafeEqual } from "crypto";
import { BillingEventQueue, IQueuedBillingEvent } from "./BillingEventQueue";
import { parseBillingWebhook } from "./BillingServiceImpl";
import { BillingWebhookIntake } from "./BillingWebhookIntake";
import { SqsBillingEventQueueImpl } from "./SqsBillingEventQueueImpl";
import { UnauthorizedError, ValidationError } from "../common/errors";

export class BillingWebhookIntakeImpl implements BillingWebhookIntake {
    private readonly queue: BillingEventQueue;
    private readonly expectedAuthorization: () => Promise<string>;
    private readonly now: () => Date;

    /**
     * @param expectedAuthorization Resolves to the Authorization header value RevenueCat is configured
     * to send; an empty value accepts nothing.
     */
    constructor(
        expectedAuthorization: () => Promise<string>,
        queue: BillingEventQueue = new SqsBillingEventQueueImpl(),
        now: () => Date = () => new Date(),
    ) {
        this.expectedAuthorization = expectedAuthorization;
        this.queue = queue;
        this.now = now;
    }

    public async accept(authorization: string | undefined, body: string | null): Promise<IQueuedBillingEvent> {
        if (!authorizationMatches(authorization, await this.expectedAuthorization())) {
            throw new UnauthorizedError("Invalid webhook authorization");
        }

        const event = parseBillingWebhook(parseJson(body));
        const queued: IQueuedBillingEvent = {
            body: body as string,
            type: event.type,
            eventId: typeof event.id === "string" ? event.id : undefined,
            environment: typeof event.environment === "string" ? event.environment : undefined,
            receivedAt: this.now().toISOString(),
        };

        await this.queue.enqueue(queued);

        return queued;
    }
}

/** Constant-time comparison of the webhook's Authorization header with the configured value. */
export function authorizationMatches(provided: string | undefined, expected: string): boolean {
    if (!provided || !expected) {
        return false;
    }

    // Plain byte arrays rather than Buffers: every TypeScript version types these the same way.
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(expected);

    return a.length === b.length && timingSafeEqual(a, b);
}

function parseJson(body: string | null): unknown {
    try {
        return JSON.parse(body ?? "");
    } catch {
        throw new ValidationError("Request body must be valid JSON");
    }
}
