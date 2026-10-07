import { CatalogSource, ICatalogDraft, ICatalogPage, ICatalogRef } from "./CatalogSource";
import { availabilityFor, genreNames, isDocumentary, providerFrom, yearOf } from "./tmdbShared";
import { TmdbClient, TmdbTvDetails } from "../TmdbClient";
import { POSTER_SIZE, PROVIDER_LOGO_SIZE } from "../config";
import { IVideoDetails } from "../domain/items";
import { IProvider } from "../domain/types";
import { EMediaType, buildItemId } from "../../media/MediaType";
import { AssetStore } from "../../storage/AssetStore";

export const TMDB_TV_SOURCE_ID = "tmdb-tv";

/** Television from TMDB. Documentary series are typed as documentaries; everything else as series. */
export class TmdbTvSource implements CatalogSource {
    public readonly id = TMDB_TV_SOURCE_ID;

    private readonly tmdb: TmdbClient;
    private readonly assetStore: AssetStore;

    constructor(tmdb: TmdbClient, assetStore: AssetStore) {
        this.tmdb = tmdb;
        this.assetStore = assetStore;
    }

    public async discover(country: string, page: number): Promise<ICatalogPage> {
        const result = await this.tmdb.discoverTv(country, page);

        return { refs: result.results.map(show => ({ sourceId: String(show.id) })), totalPages: result.totalPages };
    }

    public async fetch(ref: ICatalogRef, countries: string[], checkedAt: string): Promise<ICatalogDraft | null> {
        const show = await this.tmdb.getTv(Number(ref.sourceId));
        const mediaType = isDocumentary(show.genres) ? EMediaType.DOCUMENTARY : EMediaType.SERIES;
        const genres = genreNames(show.genres);
        const itemId = buildItemId(mediaType, this.id, show.id);
        const details: IVideoDetails = {
            kind: "show",
            voteCount: show.vote_count,
            episodeCount: show.number_of_episodes ?? undefined,
            seasonCount: show.number_of_seasons ?? undefined,
        };

        return {
            item: {
                itemId,
                mediaType,
                title: show.name,
                year: yearOf(show.first_air_date),
                // For a series the runtime constraint applies to one episode.
                runtime: typicalEpisodeRuntime(show),
                genres,
                primaryGenre: genres[0],
                rating: contentRatingsFor(show, countries),
                popularity: show.popularity,
                posterKey: show.poster_path ? `posters/${this.id}-${show.id}.jpg` : undefined,
                availability: availabilityFor(show["watch/providers"]?.results, countries, checkedAt),
                details,
            },
            moodSource: {
                itemId,
                mediaType,
                title: show.name,
                year: yearOf(show.first_air_date),
                genres,
                overview: show.overview,
                keywords: show.keywords?.results.map(keyword => keyword.name) ?? [],
            },
            imageUrl: show.poster_path ? this.tmdb.imageUrl(show.poster_path, POSTER_SIZE) : undefined,
        };
    }

    public async listProviders(country: string): Promise<IProvider[]> {
        const refs = await this.tmdb.listProviders(country, "tv");
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

function typicalEpisodeRuntime(show: TmdbTvDetails): number | undefined {
    const runtimes = (show.episode_run_time ?? []).filter(minutes => minutes > 0);

    if (runtimes.length === 0) {
        return undefined;
    }

    return Math.round(runtimes.reduce((sum, minutes) => sum + minutes, 0) / runtimes.length);
}

function contentRatingsFor(show: TmdbTvDetails, countries: string[]): Record<string, string> | undefined {
    const ratings: Record<string, string> = {};

    for (const country of countries) {
        const rating = show.content_ratings?.results.find(entry => entry.iso_3166_1 === country)?.rating;

        if (rating) {
            ratings[country] = rating;
        }
    }

    return Object.keys(ratings).length > 0 ? ratings : undefined;
}
