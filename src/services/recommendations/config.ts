/** Tunables for the recommendation pipeline. Environment overrides are read where noted. */
export const RESULT_COUNT = 8;
export const CANDIDATE_COUNT = 40;
/** At most this many of the final results may share a primary genre. */
export const MAX_PER_GENRE = 2;
/** A cached "why" line older than this is regenerated. */
export const WHY_STALE_DAYS = 30;
/** Requests table items expire after this long. */
export const REQUEST_TTL_DAYS = 90;
export const DEFAULT_DAILY_CAP = 20;
export const DEFAULT_MOOD_MODEL_ID = "anthropic.claude-opus-5-5";
export const DEFAULT_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_MOVIES_INDEX = "movies";

/** Re-ranking weights; they sum to one. */
export const RANK_WEIGHTS = {
    similarity: 0.5,
    popularity: 0.2,
    recency: 0.1,
    personal: 0.2,
} as const;

/** Thumbs-up on a title adds this much to its personal signal (before clamping to 1). */
export const THUMBS_UP_BONUS = 0.5;

export const DEFAULT_SUPPORTIVE_MESSAGE =
    "It sounds like you're carrying a lot right now, and it matters that you said so. " +
    "Rather than a film, this might be a moment to reach out to someone you trust, or to a local support line. " +
    "We're here whenever you'd like a recommendation.";

export function dailyCapFromEnvironment(): number {
    const parsed = Number(process.env.DAILY_REQUEST_CAP);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}
