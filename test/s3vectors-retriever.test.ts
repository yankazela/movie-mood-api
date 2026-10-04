import { S3VectorsCandidateRetrieverImpl, buildCandidateFilter } from "../src/services/recommendations/S3VectorsCandidateRetrieverImpl";
import { IVectorMatch, VectorFilter, VectorIndex } from "../src/services/vectors/VectorIndex";

describe("buildCandidateFilter", () => {
    test("filters by service tokens, rating tokens and runtime when all are given", () => {
        expect(buildCandidateFilter({ country: "ZA", services: ["netflix", "showmax"], ratingsAllowed: ["PG", "13"], maxRuntimeMin: 120 })).toEqual({
            $and: [
                { availableOn: { $in: ["ZA:netflix", "ZA:showmax"] } },
                { ratings: { $in: ["ZA:PG", "ZA:13"] } },
                { runtime: { $lte: 120 } },
            ],
        });
    });

    test("falls back to any service in the country when the user lists none", () => {
        expect(buildCandidateFilter({ country: "ZA", services: [], ratingsAllowed: [] })).toEqual({ countries: { $eq: "ZA" } });
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

    test("maps matches to candidates and turns cosine distance into similarity", async () => {
        const index = new FakeIndex([
            { key: "tmdb:1", distance: 0.1, metadata: { movieId: "tmdb:1", popularity: 50, year: 2020, primaryGenre: "comedy", genres: ["comedy", "drama"], runtime: 100 } },
            { key: "tmdb:2", distance: 0.6, metadata: { movieId: "tmdb:2", popularity: 5 } },
        ]);
        const retriever = new S3VectorsCandidateRetrieverImpl(index);

        const candidates = await retriever.retrieve([0.1, 0.2], { country: "ZA", services: ["netflix"], ratingsAllowed: [] }, 40);

        expect(index.queries[0].topK).toBe(40);
        expect(index.queries[0].filter).toEqual({ availableOn: { $in: ["ZA:netflix"] } });
        expect(candidates[0]).toEqual({ movieId: "tmdb:1", similarity: 0.9, popularity: 50, year: 2020, primaryGenre: "comedy", genres: ["comedy", "drama"], runtime: 100 });
        expect(candidates[1]).toMatchObject({ movieId: "tmdb:2", similarity: 0.4, popularity: 5, genres: [] });
    });
});
