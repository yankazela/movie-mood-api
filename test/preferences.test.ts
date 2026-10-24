import { expandGenres, expandRatings, expandServices, normalizeGenre, serviceIdForSlug } from "../src/services/recommendations/preferences";
import { rerank } from "../src/services/recommendations/ranking";
import { EMediaType } from "../src/services/media/MediaType";

describe("expandServices", () => {
    test("turns the app's short ids into catalogue provider slugs", () => {
        expect(expandServices(["prime", "disney"])).toEqual(expect.arrayContaining(["amazon-prime-video", "disney-plus"]));
    });

    test("keeps slugs the app does not know, lower-cased and de-duplicated", () => {
        expect(expandServices(["Showmax", "showmax", "hulu"])).toEqual(["showmax", "hulu"]);
    });

    test("maps a slug back to the app's id", () => {
        expect(serviceIdForSlug("amazon-prime-video")).toBe("prime");
        expect(serviceIdForSlug("netflix")).toBe("netflix");
        expect(serviceIdForSlug("showmax")).toBeUndefined();
    });
});

describe("expandRatings", () => {
    test("means no restriction when nothing is allowed", () => {
        expect(expandRatings("ZA", [])).toEqual([]);
    });

    test("a level stands for that level and everything gentler, in the country's own certifications", () => {
        const za = expandRatings("ZA", ["G", "PG", "PG-13"]);

        expect(za).toEqual(expect.arrayContaining(["PG", "13"]));
        expect(za).not.toContain("16");
        expect(za).not.toContain("18");

        const us = expandRatings("US", ["PG"]);

        expect(us).toEqual(expect.arrayContaining(["G", "PG"]));
        expect(us).not.toContain("PG-13");
    });

    test("R allows everything the country lists", () => {
        expect(expandRatings("CA", ["R"])).toEqual(expect.arrayContaining(["G", "14A", "18A"]));
    });

    test("keeps native certifications the caller already used", () => {
        expect(expandRatings("ZA", ["16"])).toEqual(["16"]);
        expect(expandRatings("ZA", ["PG", "16"])).toEqual(expect.arrayContaining(["16", "PG"]));
    });

    test("falls back to the US table for a country it does not know", () => {
        expect(expandRatings("NZ", ["PG-13"])).toEqual(expect.arrayContaining(["PG-13", "TV-14"]));
    });
});

describe("genres", () => {
    test("normalizes hyphenated app ids to catalogue names", () => {
        expect(normalizeGenre("Science-Fiction")).toBe("science fiction");
    });

    test("expands to the combined television genres too", () => {
        expect(expandGenres(["science-fiction"])).toEqual(["science fiction", "sci-fi & fantasy"]);
        expect(expandGenres(["comedy"])).toEqual(["comedy"]);
    });

    test("genre preferences written with app ids still lift catalogue genres", () => {
        const base = { mediaType: EMediaType.MOVIE, similarity: 0.5, popularity: 100, year: 2020 };
        const ranked = rerank(
            [
                { ...base, itemId: "comedy", primaryGenre: "comedy", genres: ["comedy"] },
                { ...base, itemId: "scifi", primaryGenre: "science fiction", genres: ["science fiction"] },
            ],
            { genrePrefs: { "science-fiction": 1, comedy: 0 }, votes: {} },
        );

        expect(ranked[0].itemId).toBe("scifi");
    });
});
