import { IProvidersItem } from "../catalog/domain/types";

export interface ProviderRepository {
    save(item: IProvidersItem): Promise<void>;
}
