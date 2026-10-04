import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ProviderRepository } from "./ProviderRepository";
import { IProvidersItem } from "../catalog/domain/types";

export class ProviderRepositoryImpl implements ProviderRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
            marshallOptions: { removeUndefinedValues: true },
        }),
        tableName: string = process.env.PROVIDERS_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async save(item: IProvidersItem): Promise<void> {
        await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: item }));
    }
}
