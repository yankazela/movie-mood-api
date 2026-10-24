import { ICandidate, IRankedCandidate } from "./domain/types";
import { EVote, IVote } from "../users/domain/types";
import { RANK_WEIGHTS, THUMBS_UP_BONUS } from "./config";
import { expandGenres } from "./preferences";

export interface IPersonalSignals {
    /** Genre name to preference weight, 0..1. */
    genrePrefs: Record<string, number>;
    /** Item id to the user's thumbs vote. */
    votes: Record<string, IVote>;
    /** Item ids the user has already watched; they are not recommended again. */
    watched?: string[];
}

/**
 * Scores candidates by similarity, popularity, recency and personal signal, drops titles the
 * user thumbed down or has already watched, and returns them best first.
 */
export function rerank(candidates: ICandidate[], personal: IPersonalSignals, now: Date = new Date()): IRankedCandidate[] {
    const watched = new Set(personal.watched ?? []);
    const kept = candidates.filter(candidate => personal.votes[candidate.itemId]?.vote !== EVote.DOWN && !watched.has(candidate.itemId));

    if (kept.length === 0) {
        return [];
    }

    const similarity = minMax(kept.map(candidate => candidate.similarity));
    const popularity = minMax(kept.map(candidate => Math.log1p(Math.max(0, candidate.popularity))));
    const currentYear = now.getUTCFullYear();
    const genreWeights = genreWeightsByName(personal.genrePrefs);

    return kept
        .map((candidate, index) => ({
            ...candidate,
            score:
                RANK_WEIGHTS.similarity * similarity[index] +
                RANK_WEIGHTS.popularity * popularity[index] +
                RANK_WEIGHTS.recency * recency(candidate.year, currentYear) +
                RANK_WEIGHTS.personal * personalSignal(candidate, personal, genreWeights),
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

function personalSignal(candidate: ICandidate, personal: IPersonalSignals, genreWeights: Map<string, number>): number {
    const weights = candidate.genres
        .map(genre => genreWeights.get(genre))
        .filter((weight): weight is number => typeof weight === "number");

    const genrePrior = weights.length > 0
        ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length
        : 0.5;

    const thumbsUp = personal.votes[candidate.itemId]?.vote === EVote.UP ? THUMBS_UP_BONUS : 0;

    return clamp01(genrePrior + thumbsUp);
}

/** Genre preferences keyed by catalogue genre name, whatever vocabulary the user's keys were written in. */
function genreWeightsByName(genrePrefs: Record<string, number>): Map<string, number> {
    const weights = new Map<string, number>();

    for (const [genre, weight] of Object.entries(genrePrefs)) {
        for (const name of expandGenres([genre])) {
            weights.set(name, Math.max(weights.get(name) ?? 0, weight));
        }
    }

    return weights;
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
