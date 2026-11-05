import { AsyncLocalStorage } from "async_hooks";

/**
 * The language the caller reads, for the duration of one API request. Handlers set it from the
 * Accept-Language header; the catalogue presenter reads it to pick translated titles and
 * descriptions. Request-scoped rather than passed through every service signature.
 */

/** Languages the catalogue stores translations for, besides English. Environment override: CATALOG_LANGUAGES. */
export const DEFAULT_CATALOG_LANGUAGES = ["fr", "es"];

const storage = new AsyncLocalStorage<string>();

/** The first language in an Accept-Language header, reduced to its base code ("fr-CA,fr;q=0.9" is "fr"). Undefined when absent or unreadable. */
export function localeFromHeader(header: string | undefined): string | undefined {
    const first = header?.split(",")
        .map(part => {
            const [tag, ...params] = part.trim().split(";");
            const q = Number(params.find(param => param.trim().startsWith("q="))?.split("=")[1] ?? "1");
            return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 };
        })
        .filter(entry => entry.tag && entry.tag !== "*" && entry.q > 0)
        .sort((a, b) => b.q - a.q)[0];
    const base = first?.tag.split("-")[0].toLowerCase();

    return base && /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

export function runWithLocale<T>(locale: string | undefined, task: () => T): T {
    return storage.run(locale ?? "en", task);
}

/** The current request's language; English outside a request. */
export function requestLocale(): string {
    return storage.getStore() ?? "en";
}

export function catalogLanguagesFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
    const languages = (env.CATALOG_LANGUAGES ?? "").split(",").map(language => language.trim().toLowerCase()).filter(language => /^[a-z]{2,3}$/.test(language) && language !== "en");

    return languages.length > 0 ? [...new Set(languages)] : DEFAULT_CATALOG_LANGUAGES;
}
