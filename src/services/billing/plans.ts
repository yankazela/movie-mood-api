import { EPlan, IUsage } from "./domain/types";
import { IUser } from "../users/domain/types";

export type DailyCaps = Record<EPlan, number>;

/** Recommendation requests per UTC day. Environment overrides: DAILY_CAP_FREE and DAILY_CAP_ADVANCED. */
export const DEFAULT_DAILY_CAPS: DailyCaps = {
    [EPlan.FREE]: 2,
    [EPlan.ADVANCED]: 15,
};

export function dailyCapsFromEnvironment(env: NodeJS.ProcessEnv = process.env): DailyCaps {
    return {
        [EPlan.FREE]: capFrom(env.DAILY_CAP_FREE, DEFAULT_DAILY_CAPS[EPlan.FREE]),
        [EPlan.ADVANCED]: capFrom(env.DAILY_CAP_ADVANCED, DEFAULT_DAILY_CAPS[EPlan.ADVANCED]),
    };
}

function capFrom(raw: string | undefined, fallback: number): number {
    const parsed = Number(raw);

    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The plan a user is on right now: advanced only while the stored plan has not lapsed, free
 * otherwise. Profiles from before billing existed have no plan field, which means free.
 */
export function effectivePlan(user: Pick<IUser, "plan" | "planExpiresAt">, now: Date = new Date()): EPlan {
    if (user.plan !== EPlan.ADVANCED) {
        return EPlan.FREE;
    }

    if (!user.planExpiresAt) {
        return EPlan.ADVANCED;
    }

    const expiresAt = Date.parse(user.planExpiresAt);

    return !Number.isNaN(expiresAt) && expiresAt > now.getTime() ? EPlan.ADVANCED : EPlan.FREE;
}

/** The UTC day a moment falls on, as the Users table stores it (YYYY-MM-DD). */
export function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/** The next UTC midnight after `now`: when the daily counters restart. */
export function nextUtcMidnight(now: Date): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** Requests the profile records for today; a counter left over from an earlier day no longer counts. */
export function usedToday(user: Pick<IUser, "dailyCount" | "dailyCountDate">, now: Date): number {
    return user.dailyCountDate === utcDay(now) ? user.dailyCount ?? 0 : 0;
}

export function usageFor(user: IUser, caps: DailyCaps, now: Date = new Date()): IUsage {
    const plan = effectivePlan(user, now);
    const limit = caps[plan];
    const used = usedToday(user, now);

    return { plan, used, limit, remaining: Math.max(0, limit - used), resetsAt: nextUtcMidnight(now) };
}

/** The person-facing text for a 429; the app shows it as is. */
export function dailyLimitMessage(plan: EPlan, caps: DailyCaps): string {
    const limit = caps[plan];
    const noun = limit === 1 ? "request" : "requests";

    return plan === EPlan.FREE
        ? `You've used your ${limit} free ${noun} for today. Upgrade to Advanced for ${caps[EPlan.ADVANCED]} a day, or come back tomorrow.`
        : `You've used all ${limit} ${noun} for today. Come back tomorrow.`;
}
