import { IRefreshOptions, IRefreshResult } from "./domain/types";

export interface CatalogRefreshService {
    /**
     * Walks TMDB's most popular streamable films for each configured country, writing metadata,
     * availability, ratings and posters to the Movies table and mood embeddings to the vector
     * index. Progress is saved after every page so a run can pause and resume.
     */
    refresh(options: IRefreshOptions): Promise<IRefreshResult>;
}
