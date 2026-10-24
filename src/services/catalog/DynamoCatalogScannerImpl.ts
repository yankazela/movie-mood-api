import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { CatalogScanner } from "./CatalogScanner";
import { ICatalogItem } from "./domain/items";

const FIELDS = ["movieId", "mediaType", "title", "year", "runtime", "genres", "primaryGenre", "rating", "popularity", "posterKey", "availability", "details"];

/** Scans the Movies table (keyed by `movieId`), leaving out the large moodDesc and why attributes. */
export class DynamoCatalogScannerImpl implements CatalogScanner {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
        tableName: string = process.env.MOVIES_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async scanVideo(): Promise<ICatalogItem[]> {
        const names = Object.fromEntries(FIELDS.map(field => [`#${field}`, field]));
        const items: ICatalogItem[] = [];
        let startKey: Record<string, unknown> | undefined;

        do {
            const page = await this.documentClient.send(new ScanCommand({
                TableName: this.tableName,
                ProjectionExpression: FIELDS.map(field => `#${field}`).join(", "),
                ExpressionAttributeNames: names,
                ExclusiveStartKey: startKey,
            }));

            for (const record of page.Items ?? []) {
                const { movieId, ...rest } = record;

                items.push({ ...rest, itemId: movieId } as ICatalogItem);
            }

            startKey = page.LastEvaluatedKey;
        } while (startKey);

        return items;
    }
}
