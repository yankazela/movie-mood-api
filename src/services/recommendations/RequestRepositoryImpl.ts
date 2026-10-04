import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { RequestRepository } from "./RequestRepository";
import { IRecommendationRequest } from "./domain/types";

export class RequestRepositoryImpl implements RequestRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
            marshallOptions: { removeUndefinedValues: true },
        }),
        tableName: string = process.env.REQUESTS_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async save(request: IRecommendationRequest): Promise<void> {
        await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: request,
        }));
    }
}
