import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConfigRepository } from "./ConfigRepository";

export class ConfigRepositoryImpl implements ConfigRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
            marshallOptions: { removeUndefinedValues: true },
        }),
        tableName: string = process.env.CONFIG_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async get(configKey: string): Promise<Record<string, unknown> | null> {
        const result = await this.documentClient.send(new GetCommand({
            TableName: this.tableName,
            Key: { configKey },
        }));

        return (result.Item as Record<string, unknown> | undefined) ?? null;
    }

    public async put(configKey: string, fields: Record<string, unknown>): Promise<void> {
        await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: { ...fields, configKey },
        }));
    }
}
