import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RequestRepository } from "./RequestRepository";
import { IRequestOutcome, RequestHistoryRepository } from "./RequestHistoryRepository";
import { IRecommendationRequest } from "./domain/types";
import { NotFoundError } from "../common/errors";

export class RequestRepositoryImpl implements RequestRepository, RequestHistoryRepository {
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

    public async listByUser(userId: string, limit: number): Promise<IRecommendationRequest[]> {
        const result = await this.documentClient.send(new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "userId = :userId",
            ExpressionAttributeValues: { ":userId": userId },
            ScanIndexForward: false,
            Limit: limit,
        }));

        return (result.Items ?? []) as IRecommendationRequest[];
    }

    public async recordOutcome(userId: string, requestedAt: string, outcome: IRequestOutcome): Promise<IRecommendationRequest> {
        const names: Record<string, string> = { "#userId": "userId" };
        const values: Record<string, unknown> = {};
        const assignments: string[] = [];

        Object.entries(outcome).forEach(([field, value], index) => {
            if (value === undefined) return;
            names[`#f${index}`] = field;
            values[`:f${index}`] = value;
            assignments.push(`#f${index} = :f${index}`);
        });

        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId, requestedAt },
                UpdateExpression: `SET ${assignments.join(", ")}`,
                ConditionExpression: outcome.selectedItemId
                    ? "attribute_exists(#userId) AND contains(#resultIds, :selected)"
                    : "attribute_exists(#userId)",
                ExpressionAttributeNames: outcome.selectedItemId ? { ...names, "#resultIds": "resultIds" } : names,
                ExpressionAttributeValues: outcome.selectedItemId ? { ...values, ":selected": outcome.selectedItemId } : values,
                ReturnValues: "ALL_NEW",
            }));

            return result.Attributes as IRecommendationRequest;
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                throw new NotFoundError("No recommendation request found with that id and title.");
            }

            throw error;
        }
    }
}
