import { IRefreshOptions, IRefreshResult } from "./domain/types";

export interface CatalogRefreshService {
    /**
     * Walks every catalogue source for each configured country, writing metadata, availability,
     * ratings and posters to the catalogue tables and mood embeddings to the vector index.
     * Progress is saved after every page so a run can pause and resume.
     */
    refresh(options: IRefreshOptions): Promise<IRefreshResult>;
}
