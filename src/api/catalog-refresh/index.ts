import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CatalogRefreshServiceImpl } from "../../services/catalog/CatalogRefreshServiceImpl";
import { DEFAULT_MAX_PAGES_PER_COUNTRY, DEFAULT_TIME_BUDGET_MS, positiveIntFromEnvironment } from "../../services/catalog/config";
import { IRefreshResult } from "../../services/catalog/domain/types";

interface RefreshEvent {
    /** Set when this invocation continues a run that paused for its time budget. */
    continuation?: boolean;
}

// Built lazily because the TMDB credential comes from Secrets Manager; reused across invocations.
let servicePromise: Promise<CatalogRefreshServiceImpl> | undefined;
const lambda = new LambdaClient({});

/**
 * Nightly catalog refresh, triggered by EventBridge. Each invocation works within a time budget,
 * saves its cursor, and re-invokes itself asynchronously when pages remain.
 */
export const run = async (event: RefreshEvent = {}): Promise<IRefreshResult> => {
    servicePromise ??= CatalogRefreshServiceImpl.create().catch(error => {
        servicePromise = undefined;
        throw error;
    });
    const service = await servicePromise;

    const result = await service.refresh({
        timeBudgetMs: positiveIntFromEnvironment("CATALOG_TIME_BUDGET_MS", DEFAULT_TIME_BUDGET_MS),
        maxPagesPerCountry: positiveIntFromEnvironment("CATALOG_MAX_PAGES", DEFAULT_MAX_PAGES_PER_COUNTRY),
    });

    console.log(JSON.stringify({ ...result, continuation: Boolean(event.continuation) }));

    if (result.status === "paused" && process.env.AWS_LAMBDA_FUNCTION_NAME) {
        await lambda.send(new InvokeCommand({
            FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ continuation: true } satisfies RefreshEvent)),
        }));
    }

    return result;
};
