import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EntitlementProvider } from "./EntitlementProvider";
import { EPlan, EPlanSource, IEntitlement } from "./domain/types";
import { ServiceUnavailableError } from "../common/errors";

const BASE_URL = "https://api.revenuecat.com/v1";
export const DEFAULT_ENTITLEMENT_ID = "upmymood_pro";

/** The secret holds both halves of the RevenueCat integration, as JSON. */
export interface RevenueCatCredentials {
    /** Secret API key (sk_...), used to read subscribers. Empty until the project is set up. */
    apiKey: string;
    /** The exact Authorization header value RevenueCat is configured to send to the webhook. */
    webhookAuthorization: string;
}

/** The parts of GET /v1/subscribers/{app_user_id} this service reads. */
export interface IRevenueCatSubscriberResponse {
    /** The provider's clock when it answered; expiry is compared against it, not the Lambda's clock. */
    request_date?: string;
    subscriber?: {
        entitlements?: Record<string, {
            expires_date: string | null;
            grace_period_expires_date?: string | null;
            product_identifier: string;
            purchase_date?: string;
        }>;
        subscriptions?: Record<string, {
            expires_date?: string | null;
            store?: string;
            unsubscribe_detected_at?: string | null;
            billing_issues_detected_at?: string | null;
        }>;
    };
}

/** RevenueCat over its REST API. The same client answers the webhook's shared secret. */
export class RevenueCatClientImpl implements EntitlementProvider {
    private readonly credentials: () => Promise<RevenueCatCredentials>;
    private readonly entitlementId: string;
    private readonly fetchImpl: typeof fetch;
    private readonly baseUrl: string;

    constructor(
        credentials: () => Promise<RevenueCatCredentials>,
        entitlementId: string = process.env.REVENUECAT_ENTITLEMENT_ID || DEFAULT_ENTITLEMENT_ID,
        fetchImpl: typeof fetch = fetch,
        baseUrl: string = BASE_URL,
    ) {
        this.credentials = credentials;
        this.entitlementId = entitlementId;
        this.fetchImpl = fetchImpl;
        this.baseUrl = baseUrl;
    }

    /** Reads the credentials from Secrets Manager once per container. Without a secret id, billing is unconfigured. */
    public static fromSecret(
        secretId: string = process.env.REVENUECAT_SECRET_ARN || "",
        client: SecretsManagerClient = new SecretsManagerClient({}),
    ): RevenueCatClientImpl {
        let cached: Promise<RevenueCatCredentials> | undefined;

        return new RevenueCatClientImpl(() => {
            if (!secretId) {
                return Promise.resolve({ apiKey: "", webhookAuthorization: "" });
            }

            cached ??= client.send(new GetSecretValueCommand({ SecretId: secretId }))
                .then(result => parseCredentials(result.SecretString ?? ""))
                .catch(error => {
                    cached = undefined;
                    throw error;
                });

            return cached;
        });
    }

    public async fetchEntitlement(userId: string): Promise<IEntitlement> {
        const { apiKey } = await this.credentials();

        if (!apiKey) {
            throw new ServiceUnavailableError("Billing is not configured yet. Try again later.");
        }

        const response = await this.fetchImpl(`${this.baseUrl}/subscribers/${encodeURIComponent(userId)}`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });

        console.log("Fetching entitlement for user:", userId, await response.clone().json());

        if (!response.ok) {
            throw new Error(`RevenueCat answered ${response.status} when reading subscriber ${userId}`);
        }

        return entitlementFromSubscriber((await response.json()) as IRevenueCatSubscriberResponse, this.entitlementId);
    }

    /** The Authorization header value the webhook must carry. Empty when billing is unconfigured. */
    public async webhookAuthorization(): Promise<string> {
        return (await this.credentials()).webhookAuthorization;
    }
}

/** Turns a subscriber record into the plan we store. Only the named entitlement counts. */
export function entitlementFromSubscriber(payload: IRevenueCatSubscriberResponse, entitlementId: string): IEntitlement {
    const entitlement = payload.subscriber?.entitlements?.[entitlementId];

    if (!entitlement) {
        return { plan: EPlan.FREE };
    }

    const now = Date.parse(payload.request_date ?? "") || Date.now();
    // A null expiry is a lifetime grant. A grace period keeps access while a failed payment is retried.
    const expiry = latest(entitlement.expires_date, entitlement.grace_period_expires_date);
    const active = expiry === null || expiry > now;
    const subscription = payload.subscriber?.subscriptions?.[entitlement.product_identifier];
    const source = sourceFromStore(subscription?.store);
    const willRenew = active
        && expiry !== null
        && source !== EPlanSource.PROMOTIONAL
        && !subscription?.unsubscribe_detected_at
        && !subscription?.billing_issues_detected_at;

    return {
        plan: active ? EPlan.ADVANCED : EPlan.FREE,
        expiresAt: expiry === null ? undefined : new Date(expiry).toISOString(),
        source,
        willRenew,
        productId: entitlement.product_identifier,
    };
}

/** The later of the given dates in epoch ms; null when any of them is null (no expiry at all). */
function latest(...dates: (string | null | undefined)[]): number | null {
    const defined = dates.filter((date): date is string | null => date !== undefined);

    if (defined.length === 0 || defined.some(date => date === null)) {
        return null;
    }

    return Math.max(...defined.map(date => Date.parse(date as string)).filter(time => !Number.isNaN(time)));
}

function sourceFromStore(store: string | undefined): EPlanSource | undefined {
    switch (store?.toLowerCase()) {
        case undefined:
            return undefined;
        case "app_store":
        case "mac_app_store":
            return EPlanSource.APPLE;
        case "play_store":
            return EPlanSource.GOOGLE;
        case "stripe":
            return EPlanSource.STRIPE;
        case "promotional":
            return EPlanSource.PROMOTIONAL;
        default:
            return EPlanSource.OTHER;
    }
}

function parseCredentials(raw: string): RevenueCatCredentials {
    try {
        const parsed = JSON.parse(raw) as Partial<RevenueCatCredentials>;

        return {
            apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
            webhookAuthorization: typeof parsed.webhookAuthorization === "string" ? parsed.webhookAuthorization.trim() : "",
        };
    } catch {
        return { apiKey: "", webhookAuthorization: "" };
    }
}
