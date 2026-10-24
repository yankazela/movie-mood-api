import { ApiResponse, ResponseService } from "@novha/cdk-lib";
import { APIGatewayProxyEvent, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { errorResponse } from "../common/responses";
import { requireUserId } from "../common/request";
import { BillingService } from "../../services/billing/BillingService";
import { BillingServiceImpl } from "../../services/billing/BillingServiceImpl";
import { processBillingRecords } from "../../services/billing/BillingEventProcessor";
import { BillingWebhookIntakeImpl } from "../../services/billing/BillingWebhookIntakeImpl";
import { RevenueCatClientImpl } from "../../services/billing/RevenueCatClientImpl";

// Created once per container so the Secrets Manager, SQS and DynamoDB clients are reused. The
// three handlers share this bundle but each only touches what it needs.
const revenueCat = RevenueCatClientImpl.fromSecret();
const intake = new BillingWebhookIntakeImpl(() => revenueCat.webhookAuthorization());
let billing: BillingService | undefined;
const billingService = (): BillingService => (billing ??= new BillingServiceImpl(revenueCat));

/**
 * POST /billing/webhook. RevenueCat calls this on every subscription event. The route has no
 * Cognito authorizer; instead the Authorization header must equal the value stored in the
 * RevenueCat secret, which is what the dashboard is configured to send. The event is queued as
 * received and processed by `processEvents`, so RevenueCat gets its answer at once and a failure
 * downstream is retried from the queue rather than by RevenueCat.
 */
export const webhook = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const queued = await intake.accept(header(event, "authorization"), event.body);

        return responseService.success({ queued: { type: queued.type, eventId: queued.eventId, receivedAt: queued.receivedAt } });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error receiving the billing webhook");
    }
};

/**
 * SQS consumer for the billing events queue. Each record is one webhook body. Records that fail
 * are reported back individually, so only they return to the queue and, after the retry budget,
 * reach the dead-letter queue.
 */
export const processEvents = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failed = await processBillingRecords(
        event.Records.map(record => ({ messageId: record.messageId, body: record.body })),
        billingService(),
    );

    return { batchItemFailures: failed.map(itemIdentifier => ({ itemIdentifier })) };
};

/**
 * POST /billing/sync. The app calls this right after a purchase or a restore, so the profile
 * reflects the new plan without waiting for the webhook. Responds with the profile.
 */
export const sync = async (event: APIGatewayProxyEvent): Promise<ApiResponse> => {
    const responseService = new ResponseService();

    try {
        const user = await billingService().syncUser(requireUserId(event));

        return responseService.success({ user });
    } catch (error: any) {
        return errorResponse(error, responseService, "Error syncing the subscription");
    }
};

/** Header lookup that does not depend on the casing API Gateway happened to keep. */
function header(event: APIGatewayProxyEvent, name: string): string | undefined {
    const match = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);

    return match?.[1]?.trim() || undefined;
}
