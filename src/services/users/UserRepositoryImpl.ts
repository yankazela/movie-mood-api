import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { UserRepository } from "./UserRepository";
import { IUser } from "./domain/types";
import { ProfileAlreadyExistsError } from "../common/errors";

export class UserRepositoryImpl implements UserRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
            marshallOptions: { removeUndefinedValues: true },
        }),
        tableName: string = process.env.USERS_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async create(user: IUser): Promise<void> {
        try {
            await this.documentClient.send(new PutCommand({
                TableName: this.tableName,
                Item: user,
                ConditionExpression: "attribute_not_exists(userId)",
            }));
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                throw new ProfileAlreadyExistsError(user.userId);
            }

            throw error;
        }
    }

    public async findById(userId: string): Promise<IUser | null> {
        const result = await this.documentClient.send(new GetCommand({
            TableName: this.tableName,
            Key: { userId },
        }));

        return (result.Item as IUser | undefined) ?? null;
    }

    public async incrementDailyCount(userId: string, today: string): Promise<number> {
        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: "SET dailyCount = dailyCount + :one",
                ConditionExpression: "dailyCountDate = :today",
                ExpressionAttributeValues: { ":one": 1, ":today": today },
                ReturnValues: "UPDATED_NEW",
            }));

            return Number(result.Attributes?.dailyCount ?? 1);
        } catch (error) {
            if (!(error instanceof ConditionalCheckFailedException)) {
                throw error;
            }
        }

        // First request of the day (or the first ever): start today's counter at one.
        const result = await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { userId },
            UpdateExpression: "SET dailyCount = :one, dailyCountDate = :today",
            ConditionExpression: "attribute_exists(userId)",
            ExpressionAttributeValues: { ":one": 1, ":today": today },
            ReturnValues: "UPDATED_NEW",
        }));

        return Number(result.Attributes?.dailyCount ?? 1);
    }
}
