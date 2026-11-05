import { ACTIVE_MEDIA_TYPES, EMediaFamily, EMediaType, buildItemId, familiesOf, familyOf, mediaTypesInFamily, nounFor, parseItemId } from "../src/services/media/MediaType";

describe("media types", () => {
    test("item ids carry the media type and the source so they can be routed", () => {
        const itemId = buildItemId(EMediaType.SERIES, "tmdb-tv", 1399);

        expect(itemId).toBe("series:tmdb-tv:1399");
        expect(parseItemId(itemId)).toEqual({ mediaType: EMediaType.SERIES, source: "tmdb-tv", sourceId: "1399" });
    });

    test("source ids that themselves contain colons survive a round trip", () => {
        expect(parseItemId(buildItemId(EMediaType.BOOK, "openlibrary", "OL1:2")).sourceId).toBe("OL1:2");
    });

    test("rejects ids with an unknown media type", () => {
        expect(() => parseItemId("tmdb:508442")).toThrow(/Invalid item id/);
    });

    test("films, series and documentaries share the video family; music and books have their own", () => {
        expect(familyOf(EMediaType.MOVIE)).toBe(EMediaFamily.VIDEO);
        expect(familyOf(EMediaType.DOCUMENTARY)).toBe(EMediaFamily.VIDEO);
        expect(familyOf(EMediaType.MUSIC)).toBe(EMediaFamily.MUSIC);
        expect(nounFor(EMediaType.MUSIC)).toBe("album");
    });

    test("video and music are active; books wait for a catalogue source", () => {
        expect(ACTIVE_MEDIA_TYPES).toEqual([EMediaType.MOVIE, EMediaType.SERIES, EMediaType.DOCUMENTARY, EMediaType.MUSIC]);
    });

    test("groups requested types by family, in composition order", () => {
        const requested = [EMediaType.MUSIC, EMediaType.DOCUMENTARY, EMediaType.MOVIE];

        expect(familiesOf(requested)).toEqual([EMediaFamily.VIDEO, EMediaFamily.MUSIC]);
        expect(mediaTypesInFamily(requested, EMediaFamily.VIDEO)).toEqual([EMediaType.DOCUMENTARY, EMediaType.MOVIE]);
        expect(mediaTypesInFamily(requested, EMediaFamily.BOOK)).toEqual([]);
    });
});
