import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { CatalogScanner } from "./CatalogScanner";
import { ICatalogItem } from "./domain/items";

const FIELDS = ["mediaType", "title", "year", "runtime", "genres", "primaryGenre", "rating", "popularity", "posterKey", "availability", "details"];

/**
 * Scans the catalogue tables, leaving out the large moodDesc and why attributes. The Movies table
 * is keyed by `movieId` for historical reasons; the Music table by `itemId`.
 */
export class DynamoCatalogScannerImpl implements CatalogScanner {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly moviesTableName: string;
    private readonly musicTableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
        moviesTableName: string = process.env.MOVIES_TABLE_NAME || "",
        musicTableName: string = process.env.MUSIC_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.moviesTableName = moviesTableName;
        this.musicTableName = musicTableName;
    }

    public scanVideo(): Promise<ICatalogItem[]> {
        return this.scan(this.moviesTableName, "movieId");
    }

    public scanMusic(): Promise<ICatalogItem[]> {
        return this.musicTableName ? this.scan(this.musicTableName, "itemId") : Promise.resolve([]);
    }

    private async scan(tableName: string, keyAttribute: string): Promise<ICatalogItem[]> {
        const fields = [keyAttribute, ...FIELDS];
        const names = Object.fromEntries(fields.map(field => [`#${field}`, field]));
        const items: ICatalogItem[] = [];
        let startKey: Record<string, unknown> | undefined;

        do {
            const page = await this.documentClient.send(new ScanCommand({
                TableName: tableName,
                ProjectionExpression: fields.map(field => `#${field}`).join(", "),
                ExpressionAttributeNames: names,
                ExclusiveStartKey: startKey,
            }));

            for (const record of page.Items ?? []) {
                const { [keyAttribute]: key, ...rest } = record;

                items.push({ ...rest, itemId: key } as ICatalogItem);
            }

            startKey = page.LastEvaluatedKey;
        } while (startKey);

        return items;
    }
}
