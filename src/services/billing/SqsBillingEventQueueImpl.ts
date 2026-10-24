import { MessageAttributeValue, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { BillingEventQueue, IQueuedBillingEvent } from "./BillingEventQueue";
import { ServiceUnavailableError } from "../common/errors";

/** The slice of the SQS client this adapter needs, so tests can hand in a stand-in. */
export interface SqsSender {
    send(command: SendMessageCommand): Promise<unknown>;
}

/** The billing events queue on SQS. The processor Lambda is its consumer; see the API stack. */
export class SqsBillingEventQueueImpl implements BillingEventQueue {
    private readonly client: SqsSender;
    private readonly queueUrl: string;

    constructor(client: SqsSender = new SQSClient({}), queueUrl: string = process.env.BILLING_EVENTS_QUEUE_URL || "") {
        this.client = client;
        this.queueUrl = queueUrl;
    }

    public async enqueue(event: IQueuedBillingEvent): Promise<void> {
        if (!this.queueUrl) {
            throw new ServiceUnavailableError("The billing event queue is not configured");
        }

        await this.client.send(new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: event.body,
            MessageAttributes: messageAttributes({
                eventType: event.type,
                eventId: event.eventId,
                environment: event.environment,
                receivedAt: event.receivedAt,
            }),
        }));
    }
}

/** String attributes for every value that is set; they show as columns when the dead-letter queue is inspected. */
export function messageAttributes(values: Record<string, string | undefined>): Record<string, MessageAttributeValue> {
    return Object.fromEntries(
        Object.entries(values)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
            .map(([name, value]) => [name, { DataType: "String", StringValue: value }]),
    );
}
