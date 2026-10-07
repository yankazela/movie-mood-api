import { S3VectorsCandidateRetrieverImpl, buildCandidateFilter } from "../src/services/recommendations/S3VectorsCandidateRetrieverImpl";
import { EMediaType } from "../src/services/media/MediaType";
import { IVectorMatch, VectorFilter, VectorIndex } from "../src/services/vectors/VectorIndex";

const video = [EMediaType.MOVIE, EMediaType.SERIES, EMediaType.DOCUMENTARY];

describe("buildCandidateFilter", () => {
    test("always restricts media type, then applies service, rating and runtime constraints", () => {
        expect(buildCandidateFilter({ mediaTypes: video, country: "ZA", services: ["netflix", "showmax"], ratingsAllowed: ["PG", "13"], maxRuntimeMin: 120 })).toEqual({
            $and: [
                { mediaType: { $in: video } },
                { availableOn: { $in: ["ZA:netflix", "ZA:showmax"] } },
                { ratings: { $in: ["ZA:PG", "ZA:13"] } },
                { runtime: { $lte: 120 } },
            ],
        });
    });

    test("falls back to any service in the country when the user lists none", () => {
        expect(buildCandidateFilter({ mediaTypes: [EMediaType.MOVIE], country: "ZA", services: [], ratingsAllowed: [] })).toEqual({
            $and: [{ mediaType: { $in: ["movie"] } }, { countries: { $eq: "ZA" } }],
        });
    });
});

describe("S3VectorsCandidateRetrieverImpl", () => {
    class FakeIndex implements VectorIndex {
        public queries: { filter?: VectorFilter; topK: number }[] = [];

        constructor(private readonly matches: IVectorMatch[]) {}

        async upsert(): Promise<void> {}

        async delete(): Promise<void> {}

        async query(_vector: number[], filter: VectorFilter | undefined, topK: number): Promise<IVectorMatch[]> {
            this.queries.push({ filter, topK });
            return this.matches;
        }
    }

    test("maps matches to candidates, flips distance into similarity and drops records without a media type", async () => {
        const index = new FakeIndex([
            { key: "movie:tmdb-movie:1", distance: 0.1, metadata: { itemId: "movie:tmdb-movie:1", mediaType: "movie", popularity: 50, year: 2020, primaryGenre: "comedy", genres: ["comedy", "drama"], runtime: 100 } },
            { key: "series:tmdb-tv:2", distance: 0.6, metadata: { itemId: "series:tmdb-tv:2", mediaType: "series", popularity: 5 } },
            { key: "legacy", distance: 0.2, metadata: { itemId: "legacy" } },
        ]);
        const retriever = new S3VectorsCandidateRetrieverImpl(index);

        const candidates = await retriever.retrieve([0.1, 0.2], { mediaTypes: video, country: "ZA", services: ["netflix"], ratingsAllowed: [] }, 40);

        expect(index.queries[0].topK).toBe(40);
        expect(candidates).toHaveLength(2);
        expect(candidates[0]).toEqual({ itemId: "movie:tmdb-movie:1", mediaType: "movie", similarity: 0.9, popularity: 50, year: 2020, primaryGenre: "comedy", genres: ["comedy", "drama"], runtime: 100 });
        expect(candidates[1]).toMatchObject({ itemId: "series:tmdb-tv:2", mediaType: "series", similarity: 0.4, genres: [] });
    });
});
