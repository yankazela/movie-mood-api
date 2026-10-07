import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CatalogItemRepository } from "./CatalogItemRepository";
import { ICatalogItem, ICatalogItemDraft, IWhyEntry } from "../domain/items";

/** DynamoDB allows at most this many keys per BatchGetItem. */
const BATCH_GET_LIMIT = 100;
const UNPROCESSED_RETRIES = 3;

/**
 * A catalogue table in DynamoDB. One instance per media family; the partition key attribute is
 * configurable so the Movies table (keyed by `movieId`) and future tables (keyed by `itemId`)
 * share this code.
 */
export class DynamoCatalogItemRepositoryImpl implements CatalogItemRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;
    private readonly keyAttribute: string;

    constructor(documentClient: DynamoDBDocumentClient, tableName: string, keyAttribute: string = "itemId") {
        this.documentClient = documentClient;
        this.tableName = tableName;
        this.keyAttribute = keyAttribute;
    }

    public static defaultDocumentClient(): DynamoDBDocumentClient {
        return DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    }

    public async findByIds(itemIds: string[]): Promise<ICatalogItem[]> {
        const unique = [...new Set(itemIds)];
        const items: ICatalogItem[] = [];

        for (let start = 0; start < unique.length; start += BATCH_GET_LIMIT) {
            let keys = unique.slice(start, start + BATCH_GET_LIMIT).map(itemId => ({ [this.keyAttribute]: itemId }));

            for (let attempt = 0; keys.length > 0 && attempt <= UNPROCESSED_RETRIES; attempt++) {
                const result = await this.documentClient.send(new BatchGetCommand({
                    RequestItems: { [this.tableName]: { Keys: keys } },
                }));

                for (const record of result.Responses?.[this.tableName] ?? []) {
                    items.push(this.fromRecord(record));
                }

                keys = (result.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, string>[] | undefined) ?? [];
            }

            if (keys.length > 0) {
                console.warn(`${this.tableName} left ${keys.length} keys unprocessed after ${UNPROCESSED_RETRIES} retries`);
            }
        }

        return items;
    }

    public async upsertCatalog(item: ICatalogItemDraft): Promise<void> {
        const fields = Object.entries(item).filter(([name, value]) => name !== "itemId" && value !== undefined);
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};
        const assignments: string[] = [];

        fields.forEach(([name, value], index) => {
            names[`#f${index}`] = name;
            values[`:v${index}`] = value;
            assignments.push(`#f${index} = :v${index}`);
        });

        await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { [this.keyAttribute]: item.itemId },
            UpdateExpression: `SET ${assignments.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        }));
    }

    public async saveWhy(itemId: string, key: string, entry: IWhyEntry): Promise<void> {
        // A nested SET fails when the parent map does not exist yet, so make sure it does first.
        await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { [this.keyAttribute]: itemId },
            UpdateExpression: "SET #why = if_not_exists(#why, :empty)",
            ConditionExpression: `attribute_exists(#key)`,
            ExpressionAttributeNames: { "#why": "why", "#key": this.keyAttribute },
            ExpressionAttributeValues: { ":empty": {} },
        }));

        await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { [this.keyAttribute]: itemId },
            UpdateExpression: "SET #why.#entry = :entry",
            ExpressionAttributeNames: { "#why": "why", "#entry": key },
            ExpressionAttributeValues: { ":entry": entry },
        }));
    }

    private fromRecord(record: Record<string, unknown>): ICatalogItem {
        if (this.keyAttribute === "itemId") {
            return record as unknown as ICatalogItem;
        }

        const { [this.keyAttribute]: itemId, ...rest } = record;

        return { ...rest, itemId } as ICatalogItem;
    }
}
