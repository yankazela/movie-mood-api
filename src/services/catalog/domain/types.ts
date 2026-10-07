/** Progress of the current catalog run, stored in the Config table under CATALOG_CURSOR. */
export interface ICatalogCursor {
    runId: string;
    /** Id of the CatalogSource being walked. */
    source: string;
    country: string;
    page: number;
    startedAt: string;
    completedAt?: string;
}

/** A streaming provider as stored per country in the Providers table. */
export interface IProvider {
    id: number;
    /** The identifier users put in their `services` list, e.g. "netflix" or "amazon-prime-video". */
    slug: string;
    name: string;
    logoKey?: string;
    /** Search URL with a `{title}` placeholder. */
    deepLinkTemplate: string;
}

/** Item shape of the Providers table. Partition key: country. */
export interface IProvidersItem {
    country: string;
    providers: IProvider[];
    refreshedAt: string;
}

export interface IRefreshOptions {
    timeBudgetMs: number;
    maxPagesPerCountry: number;
}

export interface IRefreshResult {
    /** `paused` means the time budget ran out with pages left; the cursor is saved for the next run. */
    status: "completed" | "paused";
    runId: string;
    source: string;
    country: string;
    page: number;
    itemsProcessed: number;
}
