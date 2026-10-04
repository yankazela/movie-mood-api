export interface AssetStore {
    /** Copies the file at `url` to `key` unless an object with that key already exists. Resolves to the key. */
    ensureFromUrl(url: string, key: string): Promise<string>;
}
