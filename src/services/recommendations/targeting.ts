import { EObjective, IMoodProfile, ITarget } from "./domain/types";

/** How far `improve` lifts valence. */
const IMPROVE_VALENCE_LIFT = 0.5;
/** `improve` keeps this fraction of the arousal, i.e. moves one third of the way toward neutral. */
const IMPROVE_AROUSAL_KEEP = 2 / 3;
const UPLIFT_THEME = "uplift";

/**
 * Turns the current mood into the mood we retrieve for.
 * `keep` copies the mood vector; `improve` lifts valence, calms arousal toward neutral and adds uplift.
 */
export function applyObjective(mood: IMoodProfile, objective: EObjective): ITarget {
    if (objective === EObjective.KEEP) {
        return {
            valence: round(mood.valence),
            arousal: round(mood.arousal),
            themes_seek: [...mood.themes_seek],
        };
    }

    return {
        valence: round(clamp(mood.valence + IMPROVE_VALENCE_LIFT)),
        arousal: round(mood.arousal * IMPROVE_AROUSAL_KEEP),
        themes_seek: mood.themes_seek.includes(UPLIFT_THEME)
            ? [...mood.themes_seek]
            : [...mood.themes_seek, UPLIFT_THEME],
    };
}

/** Renders the target as the sentence that gets embedded and matched against movie embeddings. */
export function renderTargetSentence(target: ITarget, mood: IMoodProfile): string {
    const parts = [`A film that feels ${describeValence(target.valence)} and ${describeArousal(target.arousal)}`];

    if (target.themes_seek.length > 0) {
        parts.push(`with ${joinNaturally(target.themes_seek)}`);
    }

    if (mood.themes_avoid.length > 0) {
        parts.push(`avoiding ${joinNaturally(mood.themes_avoid)}`);
    }

    return `${parts.join(", ")}.`;
}

function describeValence(valence: number): string {
    if (valence < -0.6) return "bleak and heavy";
    if (valence < -0.2) return "melancholy";
    if (valence < 0.2) return "gently positive";
    if (valence < 0.6) return "warm and hopeful";
    return "joyful";
}

function describeArousal(arousal: number): string {
    if (arousal < -0.6) return "very calm and slow";
    if (arousal < -0.2) return "calm";
    if (arousal < 0.2) return "steady";
    if (arousal < 0.6) return "lively";
    return "thrilling and intense";
}

function joinNaturally(items: string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function clamp(value: number, min = -1, max = 1): number {
    return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
