import { IEntitlement } from "./domain/types";

/** Reads what the billing provider currently grants a user. */
export interface EntitlementProvider {
    /** The user's entitlement right now. A user the provider has never seen is on the free plan. */
    fetchEntitlement(userId: string): Promise<IEntitlement>;
}
