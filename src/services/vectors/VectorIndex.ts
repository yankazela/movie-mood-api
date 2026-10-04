/** Filterable metadata stored next to a vector. Arrays of strings match a filter when any element matches. */
export type VectorMetadataValue = string | number | boolean | string[];
export type VectorMetadata = Record<string, VectorMetadataValue>;

/** A metadata filter in the vector store's own JSON syntax ($eq, $in, $lte, $and, ...). */
export type VectorFilter = Record<string, unknown>;

export interface IVectorRecord {
    key: string;
    vector: number[];
    metadata: VectorMetadata;
}

export interface IVectorMatch {
    key: string;
    /** Distance in the index's metric; smaller is closer. */
    distance: number;
    metadata: VectorMetadata;
}

export interface VectorIndex {
    /** Inserts or replaces vectors by key. */
    upsert(records: IVectorRecord[]): Promise<void>;

    /** Returns the `topK` vectors nearest to `vector` among those matching `filter`. */
    query(vector: number[], filter: VectorFilter | undefined, topK: number): Promise<IVectorMatch[]>;

    delete(keys: string[]): Promise<void>;
}
