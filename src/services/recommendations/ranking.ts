import { ICandidate, IRankedCandidate } from "./domain/types";
import { EVote, IVote } from "../users/domain/types";
import { RANK_WEIGHTS, THUMBS_UP_BONUS } from "./config";

export interface IPersonalSignals {
    /** Genre name to preference weight, 0..1. */
    genrePrefs: Record<string, number>;
    /** Item id to the user's thumbs vote. */
    votes: Record<string, IVote>;
}

/**
 * Scores candidates by similarity, popularity, recency and personal signal, drops titles the
 * user thumbed down, and returns them best first.
 */
export function rerank(candidates: ICandidate[], personal: IPersonalSignals, now: Date = new Date()): IRankedCandidate[] {
    const kept = candidates.filter(candidate => personal.votes[candidate.itemId]?.vote !== EVote.DOWN);

    if (kept.length === 0) {
        return [];
    }

    const similarity = minMax(kept.map(candidate => candidate.similarity));
    const popularity = minMax(kept.map(candidate => Math.log1p(Math.max(0, candidate.popularity))));
    const currentYear = now.getUTCFullYear();

    return kept
        .map((candidate, index) => ({
            ...candidate,
            score:
                RANK_WEIGHTS.similarity * similarity[index] +
                RANK_WEIGHTS.popularity * popularity[index] +
                RANK_WEIGHTS.recency * recency(candidate.year, currentYear) +
                RANK_WEIGHTS.personal * personalSignal(candidate, personal),
        }))
        .sort((a, b) => b.score - a.score);
}

/**
 * Takes the best `count` candidates while allowing at most `maxPerGenre` titles per primary genre.
 * Candidates without a primary genre are not limited.
 */
export function selectDiverse(ranked: IRankedCandidate[], count: number, maxPerGenre: number): IRankedCandidate[] {
    const perGenre = new Map<string, number>();
    const chosen: IRankedCandidate[] = [];

    for (const candidate of ranked) {
        if (chosen.length >= count) {
            break;
        }

        const genre = candidate.primaryGenre;

        if (genre) {
            const used = perGenre.get(genre) ?? 0;

            if (used >= maxPerGenre) {
                continue;
            }

            perGenre.set(genre, used + 1);
        }

        chosen.push(candidate);
    }

    return chosen;
}

/** 1 for this year's releases, falling linearly to 0 at thirty years old. Unknown years sit in the middle. */
function recency(year: number | undefined, currentYear: number): number {
    if (!year) {
        return 0.5;
    }

    return clamp01(1 - (currentYear - year) / 30);
}

function personalSignal(candidate: ICandidate, personal: IPersonalSignals): number {
    const weights = candidate.genres
        .map(genre => personal.genrePrefs[genre])
        .filter((weight): weight is number => typeof weight === "number");

    const genrePrior = weights.length > 0
        ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length
        : 0.5;

    const thumbsUp = personal.votes[candidate.itemId]?.vote === EVote.UP ? THUMBS_UP_BONUS : 0;

    return clamp01(genrePrior + thumbsUp);
}

/** Scales values to 0..1 within the set; a set with no spread maps to 1 everywhere. */
function minMax(values: number[]): number[] {
    const min = Math.min(...values);
    const max = Math.max(...values);

    if (max - min < Number.EPSILON) {
        return values.map(() => 1);
    }

    return values.map(value => (value - min) / (max - min));
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}
