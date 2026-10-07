import { CatalogSource, ICatalogDraft, ICatalogPage, ICatalogRef } from "./CatalogSource";
import { availabilityFor, genreNames, isDocumentary, providerFrom, slugify, yearOf } from "./tmdbShared";
import { TmdbClient, TmdbMovieDetails } from "../TmdbClient";
import { POSTER_SIZE, PROVIDER_LOGO_SIZE } from "../config";
import { IVideoDetails } from "../domain/items";
import { IProvider } from "../domain/types";
import { EMediaType, buildItemId } from "../../media/MediaType";
import { AssetStore } from "../../storage/AssetStore";

export const TMDB_MOVIE_SOURCE_ID = "tmdb-movie";

/** Films from TMDB. A film whose genres include Documentary is typed as a documentary. */
export class TmdbMovieSource implements CatalogSource {
    public readonly id = TMDB_MOVIE_SOURCE_ID;

    private readonly tmdb: TmdbClient;
    private readonly assetStore: AssetStore;

    constructor(tmdb: TmdbClient, assetStore: AssetStore) {
        this.tmdb = tmdb;
        this.assetStore = assetStore;
    }

    public async discover(country: string, page: number): Promise<ICatalogPage> {
        const result = await this.tmdb.discoverMovies(country, page);

        return { refs: result.results.map(movie => ({ sourceId: String(movie.id) })), totalPages: result.totalPages };
    }

    public async fetch(ref: ICatalogRef, countries: string[], checkedAt: string): Promise<ICatalogDraft | null> {
        const movie = await this.tmdb.getMovie(Number(ref.sourceId));
        const mediaType = isDocumentary(movie.genres) ? EMediaType.DOCUMENTARY : EMediaType.MOVIE;
        const genres = genreNames(movie.genres);
        const itemId = buildItemId(mediaType, this.id, movie.id);
        const details: IVideoDetails = { kind: "film", voteCount: movie.vote_count };

        return {
            item: {
                itemId,
                mediaType,
                title: movie.title,
                year: yearOf(movie.release_date),
                runtime: movie.runtime ?? undefined,
                genres,
                primaryGenre: genres[0],
                rating: certificationsFor(movie, countries),
                popularity: movie.popularity,
                posterKey: movie.poster_path ? `posters/${this.id}-${movie.id}.jpg` : undefined,
                availability: availabilityFor(movie["watch/providers"]?.results, countries, checkedAt),
                details,
            },
            moodSource: {
                itemId,
                mediaType,
                title: movie.title,
                year: yearOf(movie.release_date),
                genres,
                overview: movie.overview,
                keywords: movie.keywords?.keywords.map(keyword => keyword.name) ?? [],
            },
            imageUrl: movie.poster_path ? this.tmdb.imageUrl(movie.poster_path, POSTER_SIZE) : undefined,
        };
    }

    public async listProviders(country: string): Promise<IProvider[]> {
        const refs = await this.tmdb.listProviders(country, "movie");
        const providers: IProvider[] = [];

        for (const ref of refs) {
            const logoKey = ref.logo_path
                ? await this.assetStore.ensureFromUrl(this.tmdb.imageUrl(ref.logo_path, PROVIDER_LOGO_SIZE), `providers/${ref.provider_id}.jpg`).catch(() => undefined)
                : undefined;

            providers.push(providerFrom(ref, country, logoKey));
        }

        return providers;
    }
}

function certificationsFor(movie: TmdbMovieDetails, countries: string[]): Record<string, string> | undefined {
    const ratings: Record<string, string> = {};

    for (const country of countries) {
        const dates = movie.release_dates?.results.find(entry => entry.iso_3166_1 === country)?.release_dates ?? [];
        const certification = (dates.find(date => date.type === 3 && date.certification) ?? dates.find(date => date.certification))?.certification;

        if (certification) {
            ratings[country] = certification;
        }
    }

    return Object.keys(ratings).length > 0 ? ratings : undefined;
}

export { slugify };
