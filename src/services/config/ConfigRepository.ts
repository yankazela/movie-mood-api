/** Key/value items in the Config table: the catalog cursor, feature flags such as vectorBackend. */
export interface ConfigRepository {
    get(configKey: string): Promise<Record<string, unknown> | null>;

    put(configKey: string, fields: Record<string, unknown>): Promise<void>;
}
