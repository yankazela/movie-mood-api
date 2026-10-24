import { EPlan, EPlanSource, IEntitlement } from "../src/services/billing/domain/types";
import { DEFAULT_DAILY_CAPS, dailyCapsFromEnvironment, dailyLimitMessage, effectivePlan, nextUtcMidnight, usageFor } from "../src/services/billing/plans";
import { IRevenueCatSubscriberResponse, RevenueCatClientImpl, entitlementFromSubscriber } from "../src/services/billing/RevenueCatClientImpl";
import { BillingServiceImpl, accountIds } from "../src/services/billing/BillingServiceImpl";
import { BillingService } from "../src/services/billing/BillingService";
import { BillingWebhookIntakeImpl, authorizationMatches } from "../src/services/billing/BillingWebhookIntakeImpl";
import { BillingEventQueue, IQueuedBillingEvent } from "../src/services/billing/BillingEventQueue";
import { SqsBillingEventQueueImpl, messageAttributes } from "../src/services/billing/SqsBillingEventQueueImpl";
import { processBillingRecords } from "../src/services/billing/BillingEventProcessor";
import { EntitlementProvider } from "../src/services/billing/EntitlementProvider";
import { UserRepository } from "../src/services/users/UserRepository";
import { UserService } from "../src/services/users/UserService";
import { EIdentityProvider, IUser } from "../src/services/users/domain/types";
import { NotFoundError, ServiceUnavailableError, UnauthorizedError, ValidationError } from "../src/services/common/errors";
import { SendMessageCommand } from "@aws-sdk/client-sqs";

const caps = { [EPlan.FREE]: 2, [EPlan.ADVANCED]: 15 };
const now = new Date("2026-10-24T18:30:00.000Z");

function user(overrides: Partial<IUser> = {}): IUser {
    return {
        userId: "sub-1",
        email: "jane@example.com",
        provider: EIdentityProvider.COGNITO,
        country: "ZA",
        services: ["netflix"],
        ratingsAllowed: ["PG"],
        genrePrefs: {},
        votes: {},
        createdAt: "2026-09-01T00:00:00Z",
        dailyCount: 0,
        fullyOnboarded: true,
        ...overrides,
    };
}

describe("plans", () => {
    test("defaults to 2 free and 15 advanced requests a day, overridable from the environment", () => {
        expect(DEFAULT_DAILY_CAPS).toEqual({ free: 2, advanced: 15 });
        expect(dailyCapsFromEnvironment({})).toEqual({ free: 2, advanced: 15 });
        expect(dailyCapsFromEnvironment({ DAILY_CAP_FREE: "3", DAILY_CAP_ADVANCED: "40" })).toEqual({ free: 3, advanced: 40 });
        // Nonsense falls back rather than opening or closing the tap.
        expect(dailyCapsFromEnvironment({ DAILY_CAP_FREE: "0", DAILY_CAP_ADVANCED: "lots" })).toEqual({ free: 2, advanced: 15 });
    });

    test("a profile is advanced only while its plan has not lapsed", () => {
        expect(effectivePlan(user(), now)).toBe(EPlan.FREE);
        expect(effectivePlan(user({ plan: EPlan.FREE }), now)).toBe(EPlan.FREE);
        // An open-ended grant has no expiry.
        expect(effectivePlan(user({ plan: EPlan.ADVANCED }), now)).toBe(EPlan.ADVANCED);
        expect(effectivePlan(user({ plan: EPlan.ADVANCED, planExpiresAt: "2026-10-24T18:30:01.000Z" }), now)).toBe(EPlan.ADVANCED);
        expect(effectivePlan(user({ plan: EPlan.ADVANCED, planExpiresAt: "2026-10-24T18:30:00.000Z" }), now)).toBe(EPlan.FREE);
        expect(effectivePlan(user({ plan: EPlan.ADVANCED, planExpiresAt: "not a date" }), now)).toBe(EPlan.FREE);
    });

    test("usage counts today's requests against the plan's cap and says when it resets", () => {
        expect(usageFor(user({ dailyCount: 1, dailyCountDate: "2026-10-24" }), caps, now))
            .toEqual({ plan: "free", used: 1, limit: 2, remaining: 1, resetsAt: "2026-10-25T00:00:00.000Z" });
        expect(usageFor(user({ dailyCount: 2, dailyCountDate: "2026-10-23" }), caps, now)).toMatchObject({ used: 0, remaining: 2 });
        expect(usageFor(user({ plan: EPlan.ADVANCED, dailyCount: 20, dailyCountDate: "2026-10-24" }), caps, now))
            .toMatchObject({ plan: "advanced", used: 20, limit: 15, remaining: 0 });
        expect(nextUtcMidnight(new Date("2026-12-31T23:59:59.000Z"))).toBe("2027-01-01T00:00:00.000Z");
    });

    test("tells free users about the upgrade and paid users to come back tomorrow", () => {
        expect(dailyLimitMessage(EPlan.FREE, caps))
            .toBe("You've used your 2 free requests for today. Upgrade to Advanced for 15 a day, or come back tomorrow.");
        expect(dailyLimitMessage(EPlan.ADVANCED, caps)).toBe("You've used all 15 requests for today. Come back tomorrow.");
    });
});

type Subscription = NonNullable<NonNullable<IRevenueCatSubscriberResponse["subscriber"]>["subscriptions"]>[string];

const requestDate = "2026-10-24T18:30:00Z";

/** A subscriber whose `advanced` entitlement comes from the advanced_monthly product. */
function paid(expires: string | null, subscription: Partial<Subscription> = {}): IRevenueCatSubscriberResponse {
    return {
        request_date: requestDate,
        subscriber: {
            entitlements: { advanced: { expires_date: expires, product_identifier: "advanced_monthly", purchase_date: "2026-10-01T00:00:00Z" } },
            subscriptions: {
                advanced_monthly: { expires_date: expires, store: "app_store", unsubscribe_detected_at: null, billing_issues_detected_at: null, ...subscription },
            },
        },
    };
}

describe("entitlementFromSubscriber", () => {
    test("a user without the entitlement is free", () => {
        expect(entitlementFromSubscriber({ request_date: requestDate, subscriber: { entitlements: {}, subscriptions: {} } }, "advanced")).toEqual({ plan: "free" });
        expect(entitlementFromSubscriber({}, "advanced")).toEqual({ plan: "free" });
    });

    test("an active App Store subscription is advanced until it expires, and renews", () => {
        expect(entitlementFromSubscriber(paid("2026-11-01T00:00:00Z"), "advanced"))
            .toEqual({ plan: "advanced", expiresAt: "2026-11-01T00:00:00.000Z", source: "apple", willRenew: true, productId: "advanced_monthly" });
    });

    test("a cancelled subscription keeps access until the end of the period but will not renew", () => {
        expect(entitlementFromSubscriber(paid("2026-11-01T00:00:00Z", { unsubscribe_detected_at: "2026-10-20T00:00:00Z" }), "advanced"))
            .toMatchObject({ plan: "advanced", willRenew: false });
    });

    test("an expired subscription is free, remembering where it came from", () => {
        expect(entitlementFromSubscriber(paid("2026-10-24T18:29:59Z"), "advanced"))
            .toMatchObject({ plan: "free", expiresAt: "2026-10-24T18:29:59.000Z", source: "apple", willRenew: false });
    });

    test("expiry is judged against the provider's clock, not ours", () => {
        const payload = paid("2026-10-24T18:29:59Z");
        payload.request_date = "2026-10-24T18:00:00Z";

        expect(entitlementFromSubscriber(payload, "advanced").plan).toBe("advanced");
    });

    test("a grace period keeps access while a failed payment is retried", () => {
        const payload = paid("2026-10-24T00:00:00Z", { billing_issues_detected_at: "2026-10-24T00:00:00Z" });
        payload.subscriber!.entitlements!.advanced.grace_period_expires_date = "2026-11-09T00:00:00Z";

        expect(entitlementFromSubscriber(payload, "advanced")).toMatchObject({ plan: "advanced", expiresAt: "2026-11-09T00:00:00.000Z", willRenew: false });
    });

    test("a lifetime or promotional grant has no expiry and does not renew", () => {
        expect(entitlementFromSubscriber(paid(null, { store: "promotional" }), "advanced"))
            .toEqual({ plan: "advanced", expiresAt: undefined, source: "promotional", willRenew: false, productId: "advanced_monthly" });
    });

    test("maps the stores and ignores other entitlements", () => {
        expect(entitlementFromSubscriber(paid("2999-01-01T00:00:00Z", { store: "play_store" }), "advanced").source).toBe(EPlanSource.GOOGLE);
        expect(entitlementFromSubscriber(paid("2999-01-01T00:00:00Z", { store: "stripe" }), "advanced").source).toBe(EPlanSource.STRIPE);
        expect(entitlementFromSubscriber(paid("2999-01-01T00:00:00Z", { store: "amazon" }), "advanced").source).toBe(EPlanSource.OTHER);
        expect(entitlementFromSubscriber(paid("2999-01-01T00:00:00Z"), "pro")).toEqual({ plan: "free" });
    });
});

describe("RevenueCatClientImpl", () => {
    function fakeFetch(status: number, body: unknown) {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
        }) as typeof fetch;

        return { calls, fetchImpl };
    }

    test("reads the subscriber with the secret key and the user's id in the path", async () => {
        const { calls, fetchImpl } = fakeFetch(200, paid("2999-01-01T00:00:00Z"));
        const client = new RevenueCatClientImpl(async () => ({ apiKey: "sk_test", webhookAuthorization: "hook-secret" }), "advanced", fetchImpl, "https://rc.test/v1");

        await expect(client.fetchEntitlement("sub 1")).resolves.toMatchObject({ plan: "advanced", source: "apple" });
        expect(calls[0].url).toBe("https://rc.test/v1/subscribers/sub%201");
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
        await expect(client.webhookAuthorization()).resolves.toBe("hook-secret");
    });

    test("is unavailable until the API key is set, and fails loudly on a bad answer", async () => {
        const unconfigured = fakeFetch(200, {});

        await expect(new RevenueCatClientImpl(async () => ({ apiKey: "", webhookAuthorization: "" }), "advanced", unconfigured.fetchImpl).fetchEntitlement("sub-1"))
            .rejects.toBeInstanceOf(ServiceUnavailableError);
        expect(unconfigured.calls).toHaveLength(0);

        const failing = fakeFetch(500, {});

        await expect(new RevenueCatClientImpl(async () => ({ apiKey: "sk", webhookAuthorization: "" }), "advanced", failing.fetchImpl).fetchEntitlement("sub-1"))
            .rejects.toThrow("RevenueCat answered 500");
    });
});

class FakeEntitlements implements EntitlementProvider {
    public asked: string[] = [];

    constructor(private readonly byUser: Record<string, IEntitlement>) {}

    async fetchEntitlement(userId: string): Promise<IEntitlement> {
        this.asked.push(userId);
        return this.byUser[userId] ?? { plan: EPlan.FREE };
    }
}

class FakeUsers implements UserRepository {
    public planChanges: { userId: string; entitlement: IEntitlement; syncedAt: string }[] = [];
    public readonly stored = new Map<string, IUser>();

    constructor(known: string[]) {
        known.forEach(userId => this.stored.set(userId, user({ userId })));
    }

    async create(): Promise<void> {}

    async findById(userId: string): Promise<IUser | null> {
        return this.stored.get(userId) ?? null;
    }

    async update(): Promise<IUser> {
        throw new Error("not used");
    }

    async reserveDailyRequest(): Promise<number | null> {
        throw new Error("not used");
    }

    async releaseDailyRequest(): Promise<void> {
        throw new Error("not used");
    }

    async setPlan(userId: string, entitlement: IEntitlement, syncedAt: string): Promise<IUser> {
        const current = this.stored.get(userId);

        if (!current) throw new NotFoundError("missing");

        this.planChanges.push({ userId, entitlement, syncedAt });
        const updated = { ...current, plan: entitlement.plan, planExpiresAt: entitlement.expiresAt, planSource: entitlement.source, planUpdatedAt: syncedAt };
        this.stored.set(userId, updated);

        return updated;
    }
}

/** Presents profiles the way the real service does, as far as these tests care. */
class FakeUserService implements UserService {
    constructor(private readonly users: FakeUsers) {}

    createUser(): Promise<IUser> {
        throw new Error("not used");
    }

    createProfile(): Promise<IUser> {
        throw new Error("not used");
    }

    updateUser(): Promise<IUser> {
        throw new Error("not used");
    }

    async getUser(userId: string): Promise<IUser> {
        const found = await this.users.findById(userId);

        if (!found) throw new NotFoundError("missing");

        return { ...found, plan: effectivePlan(found), usage: usageFor(found, caps) };
    }
}

describe("BillingServiceImpl", () => {
    const advanced: IEntitlement = { plan: EPlan.ADVANCED, expiresAt: "2999-01-01T00:00:00.000Z", source: EPlanSource.APPLE, willRenew: true, productId: "advanced_monthly" };

    function build(entitlements: Record<string, IEntitlement>, known = ["sub-1", "sub-2"]) {
        const provider = new FakeEntitlements(entitlements);
        const users = new FakeUsers(known);
        const service = new BillingServiceImpl(provider, users, new FakeUserService(users));

        return { provider, users, service };
    }

    test("syncUser stores what the provider says and returns the profile on its new plan", async () => {
        const { users, service } = build({ "sub-1": advanced });

        const synced = await service.syncUser("sub-1");

        expect(users.planChanges).toHaveLength(1);
        expect(users.planChanges[0]).toMatchObject({ userId: "sub-1", entitlement: advanced });
        expect(Date.parse(users.planChanges[0].syncedAt)).not.toBeNaN();
        expect(synced.plan).toBe("advanced");
        expect(synced.usage).toMatchObject({ plan: "advanced", limit: 15 });
    });

    test("syncUser fails for a user without a profile", async () => {
        await expect(build({}).service.syncUser("ghost")).rejects.toBeInstanceOf(NotFoundError);
    });

    test("a webhook syncs every account it names and ignores the provider's anonymous ids", async () => {
        const { provider, service } = build({ "sub-1": advanced });

        const synced = await service.handleWebhook({
            api_version: "1.0",
            event: { type: "INITIAL_PURCHASE", app_user_id: "sub-1", original_app_user_id: "$RCAnonymousID:abc", aliases: ["sub-1", "$RCAnonymousID:abc"] },
        });

        expect(synced).toEqual(["sub-1"]);
        expect(provider.asked).toEqual(["sub-1"]);
    });

    test("a transfer syncs both the account that lost the plan and the one that gained it", async () => {
        const { users, service } = build({ "sub-2": advanced });

        await expect(service.handleWebhook({ event: { type: "TRANSFER", transferred_from: ["sub-1"], transferred_to: ["sub-2"] } }))
            .resolves.toEqual(["sub-1", "sub-2"]);
        expect(users.planChanges.map(change => [change.userId, change.entitlement.plan])).toEqual([["sub-1", "free"], ["sub-2", "advanced"]]);
    });

    test("accounts without a profile are skipped rather than failing the webhook", async () => {
        const { service, users } = build({ "sub-1": advanced }, ["sub-1"]);

        await expect(service.handleWebhook({ event: { type: "RENEWAL", app_user_id: "stranger", aliases: ["sub-1"] } })).resolves.toEqual(["sub-1"]);
        expect(users.planChanges.map(change => change.userId)).toEqual(["sub-1"]);
    });

    test("test events do nothing and malformed bodies are rejected", async () => {
        const { service, provider } = build({});

        await expect(service.handleWebhook({ event: { type: "TEST", app_user_id: "sub-1" } })).resolves.toEqual([]);
        expect(provider.asked).toEqual([]);
        await expect(service.handleWebhook({ hello: "world" })).rejects.toBeInstanceOf(ValidationError);
        await expect(service.handleWebhook(null)).rejects.toBeInstanceOf(ValidationError);
    });

    test("accountIds dedupes and drops blanks", () => {
        expect(accountIds({ type: "X", app_user_id: " ", aliases: ["a", "a", "b"], transferred_to: ["b", "c"] })).toEqual(["a", "b", "c"]);
    });
});

describe("authorizationMatches", () => {
    test("accepts only the exact configured value", () => {
        expect(authorizationMatches("secret-token", "secret-token")).toBe(true);
        expect(authorizationMatches("secret-tokeN", "secret-token")).toBe(false);
        expect(authorizationMatches("secret", "secret-token")).toBe(false);
        expect(authorizationMatches(undefined, "secret-token")).toBe(false);
        // Nothing configured means nothing is accepted.
        expect(authorizationMatches("anything", "")).toBe(false);
    });
});

class FakeQueue implements BillingEventQueue {
    public events: IQueuedBillingEvent[] = [];
    public failWith?: Error;

    async enqueue(event: IQueuedBillingEvent): Promise<void> {
        if (this.failWith) throw this.failWith;
        this.events.push(event);
    }
}

describe("BillingWebhookIntakeImpl", () => {
    const body = JSON.stringify({ api_version: "1.0", event: { id: "evt-1", type: "RENEWAL", app_user_id: "sub-1", environment: "SANDBOX" } });

    function build(expected = "hook-secret") {
        const queue = new FakeQueue();
        const intake = new BillingWebhookIntakeImpl(async () => expected, queue, () => new Date("2026-10-24T18:30:00.000Z"));

        return { queue, intake };
    }

    test("queues a genuine event as received, tagged so it can be found again", async () => {
        const { queue, intake } = build();

        const queued = await intake.accept("hook-secret", body);

        expect(queued).toEqual({ body, type: "RENEWAL", eventId: "evt-1", environment: "SANDBOX", receivedAt: "2026-10-24T18:30:00.000Z" });
        expect(queue.events).toEqual([queued]);
    });

    test("turns away a wrong or missing Authorization header before looking at the body", async () => {
        const { queue, intake } = build();

        await expect(intake.accept("wrong", body)).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(intake.accept(undefined, body)).rejects.toBeInstanceOf(UnauthorizedError);
        // Nothing configured yet means nothing gets in.
        await expect(build("").intake.accept("", body)).rejects.toBeInstanceOf(UnauthorizedError);
        expect(queue.events).toEqual([]);
    });

    test("rejects bodies that are not a RevenueCat event, so junk never reaches the queue", async () => {
        const { queue, intake } = build();

        await expect(intake.accept("hook-secret", "not json")).rejects.toBeInstanceOf(ValidationError);
        await expect(intake.accept("hook-secret", null)).rejects.toBeInstanceOf(ValidationError);
        await expect(intake.accept("hook-secret", JSON.stringify({ event: { app_user_id: "sub-1" } }))).rejects.toBeInstanceOf(ValidationError);
        expect(queue.events).toEqual([]);
    });

    test("a queue failure surfaces as an error, so RevenueCat retries the call itself", async () => {
        const { queue, intake } = build();
        queue.failWith = new Error("SQS unavailable");

        await expect(intake.accept("hook-secret", body)).rejects.toThrow("SQS unavailable");
    });
});

describe("SqsBillingEventQueueImpl", () => {
    test("sends the raw body with string attributes to the configured queue", async () => {
        const sent: SendMessageCommand[] = [];
        const queue = new SqsBillingEventQueueImpl({ send: async (command: SendMessageCommand) => { sent.push(command); return {}; } }, "https://sqs.test/queue");

        await queue.enqueue({ body: "{\"event\":{}}", type: "RENEWAL", eventId: "evt-1", receivedAt: "2026-10-24T18:30:00.000Z" });

        expect(sent).toHaveLength(1);
        expect(sent[0].input).toEqual({
            QueueUrl: "https://sqs.test/queue",
            MessageBody: "{\"event\":{}}",
            MessageAttributes: {
                eventType: { DataType: "String", StringValue: "RENEWAL" },
                eventId: { DataType: "String", StringValue: "evt-1" },
                receivedAt: { DataType: "String", StringValue: "2026-10-24T18:30:00.000Z" },
            },
        });
    });

    test("is unavailable without a queue URL", async () => {
        const queue = new SqsBillingEventQueueImpl({ send: async () => ({}) }, "");

        await expect(queue.enqueue({ body: "{}", type: "TEST", receivedAt: "now" })).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    test("messageAttributes leaves out unset values", () => {
        expect(messageAttributes({ a: "x", b: undefined, c: "" })).toEqual({ a: { DataType: "String", StringValue: "x" } });
    });
});

describe("processBillingRecords", () => {
    class ScriptedBilling implements BillingService {
        public seen: unknown[] = [];

        syncUser(): Promise<IUser> {
            throw new Error("not used");
        }

        async handleWebhook(payload: unknown): Promise<string[]> {
            this.seen.push(payload);
            const type = (payload as { event: { type: string } }).event.type;

            if (type === "BOOM") throw new Error("RevenueCat answered 503");

            return type === "TEST" ? [] : ["sub-1"];
        }
    }

    const record = (messageId: string, type: string) => ({ messageId, body: JSON.stringify({ event: { type } }) });
    const quiet = { info: () => {}, error: () => {} };

    test("processes every record and reports back only the ones that failed", async () => {
        const billing = new ScriptedBilling();

        const failed = await processBillingRecords(
            [record("m1", "RENEWAL"), record("m2", "BOOM"), record("m3", "TEST"), { messageId: "m4", body: "not json" }],
            billing,
            quiet,
        );

        expect(failed).toEqual(["m2", "m4"]);
        expect(billing.seen).toHaveLength(3);
    });

    test("says what happened to each record", async () => {
        const lines: string[] = [];
        const logger = { info: (line?: unknown) => { lines.push(String(line)); }, error: (line?: unknown) => { lines.push(String(line)); } };

        await processBillingRecords([record("m1", "RENEWAL"), record("m2", "BOOM"), record("m3", "TEST")], new ScriptedBilling(), logger);

        expect(lines).toEqual([
            "Billing event m1 processed; synced sub-1",
            "Billing event m2 failed: RevenueCat answered 503",
            "Billing event m3 processed; synced nobody",
        ]);
    });
});
