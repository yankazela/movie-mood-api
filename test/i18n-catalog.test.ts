import { localizedTexts } from "../src/services/catalog/sources/tmdbShared";
import { toRecommendedItem } from "../src/services/catalog/presenter";
import { searchScore } from "../src/services/catalog/CatalogBrowseServiceImpl";
import { catalogLanguagesFromEnvironment, localeFromHeader, requestLocale, runWithLocale } from "../src/services/i18n/locale";
import { localized } from "../src/api/common/request";
import { TmdbTranslation } from "../src/services/catalog/TmdbClient";
import { ICatalogItem } from "../src/services/catalog/domain/items";
import { EMediaType } from "../src/services/media/MediaType";
import { APIGatewayProxyEvent } from "aws-lambda";

const translation = (iso_639_1: string, iso_3166_1: string, data: TmdbTranslation["data"]): TmdbTranslation => ({ iso_639_1, iso_3166_1, data });

describe("localizedTexts", () => {
    test("keeps title, tagline and overview per wanted language, preferring the home region", () => {
        const texts = localizedTexts([
            translation("fr", "CA", { title: "Le Parrain (QC)", overview: "Version québécoise." }),
            translation("fr", "FR", { title: "Le Parrain", overview: "Version de France.", tagline: "Une offre qu'on ne refuse pas." }),
            translation("es", "MX", { title: "El Padrino", overview: "Versión mexicana." }),
            translation("de", "DE", { title: "Der Pate" }),
        ], ["fr", "es"]);

        expect(texts).toEqual({
            fr: { title: "Le Parrain", tagline: "Une offre qu'on ne refuse pas.", overview: "Version de France." },
            es: { title: "El Padrino", overview: "Versión mexicana." },
        });
    });

    test("fills a field missing from the preferred region from another one, and uses `name` for series", () => {
        expect(localizedTexts([
            translation("es", "ES", { name: "La casa de papel", overview: "" }),
            translation("es", "MX", { name: "La casa de papel (MX)", overview: "Un grupo de atracadores..." }),
        ], ["es"])).toEqual({ es: { title: "La casa de papel", overview: "Un grupo de atracadores..." } });
    });

    test("leaves out languages with no text, and returns nothing when none have any", () => {
        expect(localizedTexts([translation("fr", "FR", { title: "  ", overview: "" })], ["fr", "es"])).toBeUndefined();
        expect(localizedTexts(undefined, ["fr"])).toBeUndefined();
    });
});

const item: ICatalogItem = {
    itemId: "movie:tmdb-movie:238",
    mediaType: EMediaType.MOVIE,
    title: "The Godfather",
    genres: ["crime", "drama"],
    availability: { CA: { services: ["netflix"], checkedAt: "2026-11-01" } },
    details: { kind: "film", overview: "Spanning the years 1945 to 1955...", tagline: "An offer you can't refuse.", voteAverage: 8.7 },
    i18n: { fr: { title: "Le Parrain", overview: "En 1945, à New York..." }, es: { title: "El padrino" } },
};

describe("toRecommendedItem", () => {
    test("uses the caller's language where the catalogue has it and English for the rest", () => {
        const french = toRecommendedItem(item, "CA", "fr");

        expect(french).toMatchObject({ title: "Le Parrain", originalTitle: "The Godfather", language: "fr", availability: { services: ["netflix"] } });
        expect(french.details).toMatchObject({ overview: "En 1945, à New York...", tagline: "An offer you can't refuse.", voteAverage: 8.7 });

        const spanish = toRecommendedItem(item, "CA", "es");
        expect(spanish).toMatchObject({ title: "El padrino", language: "es" });
        expect(spanish.details).toMatchObject({ overview: "Spanning the years 1945 to 1955..." });
    });

    test("falls back to English for English, unknown languages and untranslated items", () => {
        expect(toRecommendedItem(item, "CA", "en")).toMatchObject({ title: "The Godfather", originalTitle: undefined, language: "en" });
        expect(toRecommendedItem(item, "CA", "ja")).toMatchObject({ title: "The Godfather", language: "en" });
        expect(toRecommendedItem({ ...item, i18n: undefined }, "CA", "fr")).toMatchObject({ title: "The Godfather", language: "en" });
    });

    test("reads the request's language when none is passed", () => {
        expect(runWithLocale("fr", () => toRecommendedItem(item, "CA").title)).toBe("Le Parrain");
        expect(toRecommendedItem(item, "CA").title).toBe("The Godfather");
    });
});

describe("searchScore", () => {
    test("matches translated titles as well as the English one", () => {
        expect(searchScore(item, "le parrain")).toBe(100);
        expect(searchScore(item, "el padr")).toBe(80);
        expect(searchScore(item, "godfather")).toBe(60);
        expect(searchScore(item, "pulp fiction")).toBe(0);
    });
});

describe("locale", () => {
    test("reads the most preferred language from Accept-Language", () => {
        expect(localeFromHeader("fr")).toBe("fr");
        expect(localeFromHeader("fr-CA,fr;q=0.9,en;q=0.8")).toBe("fr");
        expect(localeFromHeader("en;q=0.5, es-MX;q=0.9")).toBe("es");
        expect(localeFromHeader("*")).toBeUndefined();
        expect(localeFromHeader(undefined)).toBeUndefined();
    });

    test("is English outside a request and scoped to the request inside one", async () => {
        expect(requestLocale()).toBe("en");
        const handler = localized(async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            return requestLocale();
        });
        const event = (headers: Record<string, string>) => ({ headers } as unknown as APIGatewayProxyEvent);

        await expect(Promise.all([handler(event({ "Accept-Language": "fr" })), handler(event({ "accept-language": "es-MX" })), handler(event({}))]))
            .resolves.toEqual(["fr", "es", "en"]);
    });

    test("catalogue languages come from the environment, without English", () => {
        expect(catalogLanguagesFromEnvironment({})).toEqual(["fr", "es"]);
        expect(catalogLanguagesFromEnvironment({ CATALOG_LANGUAGES: "fr, de, en, fr" })).toEqual(["fr", "de"]);
    });
});
