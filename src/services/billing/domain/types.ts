/** Subscription plans. The plan decides how many recommendation requests a user gets per UTC day. */
export enum EPlan {
    FREE = "free",
    ADVANCED = "advanced",
}

/** Which store or channel granted the paid plan. */
export enum EPlanSource {
    APPLE = "apple",
    GOOGLE = "google",
    STRIPE = "stripe",
    /** Granted from the billing dashboard without a purchase, e.g. for testing or goodwill. */
    PROMOTIONAL = "promotional",
    OTHER = "other",
}

/** What the billing provider currently says about a user. It is the single source of truth for the plan. */
export interface IEntitlement {
    plan: EPlan;
    /** When the paid plan lapses, or lapsed (ISO 8601). Absent for an open-ended grant or a user who never paid. */
    expiresAt?: string;
    source?: EPlanSource;
    /** False once the user cancelled or a payment failed; access continues until expiresAt. */
    willRenew?: boolean;
    /** The store product behind the plan, e.g. advanced_monthly. */
    productId?: string;
}

/** Where a user stands against today's cap. Returned with the profile and with every recommendation. */
export interface IUsage {
    plan: EPlan;
    /** Requests made so far today (UTC). */
    used: number;
    /** Requests the plan allows per UTC day. */
    limit: number;
    remaining: number;
    /** When the counter restarts: the next UTC midnight (ISO 8601). */
    resetsAt: string;
}
