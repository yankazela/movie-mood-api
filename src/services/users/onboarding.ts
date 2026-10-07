import { IUser } from "./domain/types";

type OnboardingFields = Pick<IUser, "services" | "ratingsAllowed" | "genrePrefs">;

/** A profile is fully onboarded once services, ratingsAllowed and genrePrefs are all non-empty. */
export function isFullyOnboarded(user: OnboardingFields): boolean {
    return (user.services?.length ?? 0) > 0
        && (user.ratingsAllowed?.length ?? 0) > 0
        && Object.keys(user.genrePrefs ?? {}).length > 0;
}
