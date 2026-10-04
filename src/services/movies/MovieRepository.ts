import { IMovie, IWhyEntry } from "./domain/types";

export interface MovieRepository {
    /** Fetches the given movies; ids that do not exist are simply absent from the result. */
    findByIds(movieIds: string[]): Promise<IMovie[]>;

    /** Writes one entry into the movie's `why` map, creating the map if needed. */
    saveWhy(movieId: string, key: string, entry: IWhyEntry): Promise<void>;

    /** Creates or updates the catalog fields of a movie. The `why` cache is left untouched. */
    upsertCatalog(movie: Omit<IMovie, "why">): Promise<void>;
}
