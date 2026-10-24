import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { UserFieldChanges, UserMapChanges, UserRepository } from "./UserRepository";
import { IUser, IVote } from "./domain/types";
import { IEntitlement } from "../billing/domain/types";
import { NotFoundError, ProfileAlreadyExistsError } from "../common/errors";

const MISSING_PROFILE = "No profile found for this user. Complete sign-up first.";

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

    public async update(userId: string, changes: UserFieldChanges, votes: Record<string, IVote>, mapChanges: UserMapChanges = {}): Promise<IUser> {
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};
        const assignments: string[] = [];
        const removals: string[] = [];
        const ratings = Object.entries(mapChanges.ratings ?? {});

        Object.entries(changes).forEach(([field, value], index) => {
            if (value === undefined) return;
            names[`#f${index}`] = field;
            values[`:f${index}`] = value;
            assignments.push(`#f${index} = :f${index}`);
        });

        // One SET per vote so concurrent votes on different items never overwrite each other.
        Object.entries(votes).forEach(([itemId, vote], index) => {
            names["#votes"] = "votes";
            names[`#v${index}`] = itemId;
            values[`:v${index}`] = vote;
            assignments.push(`#votes.#v${index} = :v${index}`);
        });

        (mapChanges.removeVotes ?? []).forEach((itemId, index) => {
            if (itemId in votes) return;
            names["#votes"] = "votes";
            names[`#x${index}`] = itemId;
            removals.push(`#votes.#x${index}`);
        });

        ratings.forEach(([itemId, rating], index) => {
            names["#ratings"] = "ratings";
            names[`#r${index}`] = itemId;
            values[`:r${index}`] = rating;
            assignments.push(`#ratings.#r${index} = :r${index}`);
        });

        names["#userId"] = "userId";

        // Profiles created before ratings existed have no ratings map, and a nested SET needs its parent.
        if (ratings.length > 0) {
            await this.documentClient.send(new UpdateCommand({
                Key: { userId },
                TableName: this.tableName,
                UpdateExpression: "SET #ratings = if_not_exists(#ratings, :empty)",
                ConditionExpression: "attribute_exists(#userId)",
                ExpressionAttributeNames: { "#ratings": "ratings", "#userId": "userId" },
                ExpressionAttributeValues: { ":empty": {} },
            })).catch(error => {
                if (error instanceof ConditionalCheckFailedException) {
                    throw new NotFoundError(MISSING_PROFILE);
                }

                throw error;
            });
        }

        const clauses = [
            assignments.length > 0 ? `SET ${assignments.join(", ")}` : "",
            removals.length > 0 ? `REMOVE ${removals.join(", ")}` : "",
        ].filter(Boolean);

        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: clauses.join(" "),
                ConditionExpression: "attribute_exists(#userId)",
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
                ReturnValues: "ALL_NEW",
            }));

            return result.Attributes as IUser;
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                throw new NotFoundError(MISSING_PROFILE);
            }

            throw error;
        }
    }

    public async reserveDailyRequest(userId: string, today: string, cap: number): Promise<number | null> {
        if (cap < 1) {
            return null;
        }

        // Same day: take a slot while the counter is under the cap. Otherwise the counter is from an
        // earlier day (restart it at one) or today's is full. The second pass covers the rare race
        // where another request restarted the counter between the two writes.
        for (let attempt = 0; attempt < 2; attempt++) {
            const incremented = await this.incrementUnderCap(userId, today, cap);

            if (incremented !== null) {
                return incremented;
            }

            const restarted = await this.restartCounter(userId, today);

            if (restarted !== null) {
                return restarted;
            }
        }

        return null;
    }

    public async releaseDailyRequest(userId: string, today: string): Promise<void> {
        try {
            await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: "SET dailyCount = dailyCount - :one",
                ConditionExpression: "dailyCountDate = :today AND dailyCount > :zero",
                ExpressionAttributeValues: { ":one": 1, ":today": today, ":zero": 0 },
            }));
        } catch (error) {
            // The day rolled over or the counter was reset meanwhile: there is nothing to give back.
            if (!(error instanceof ConditionalCheckFailedException)) {
                throw error;
            }
        }
    }

    public async setPlan(userId: string, entitlement: IEntitlement, syncedAt: string): Promise<IUser> {
        const fields: Record<string, unknown> = {
            plan: entitlement.plan,
            planExpiresAt: entitlement.expiresAt,
            planSource: entitlement.source,
            planWillRenew: entitlement.willRenew,
            planProductId: entitlement.productId,
            planUpdatedAt: syncedAt,
        };
        const names: Record<string, string> = { "#userId": "userId" };
        const values: Record<string, unknown> = {};
        const assignments: string[] = [];
        const removals: string[] = [];

        Object.entries(fields).forEach(([field, value], index) => {
            names[`#p${index}`] = field;

            if (value === undefined) {
                removals.push(`#p${index}`);
                return;
            }

            values[`:p${index}`] = value;
            assignments.push(`#p${index} = :p${index}`);
        });

        const clauses = [
            assignments.length > 0 ? `SET ${assignments.join(", ")}` : "",
            removals.length > 0 ? `REMOVE ${removals.join(", ")}` : "",
        ].filter(Boolean);

        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: clauses.join(" "),
                ConditionExpression: "attribute_exists(#userId)",
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
                ReturnValues: "ALL_NEW",
            }));

            return result.Attributes as IUser;
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                throw new NotFoundError(MISSING_PROFILE);
            }

            throw error;
        }
    }

    /** Adds one to today's counter if it is under the cap. Null when the stored day differs or the cap is reached. */
    private async incrementUnderCap(userId: string, today: string, cap: number): Promise<number | null> {
        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: "SET dailyCount = dailyCount + :one",
                ConditionExpression: "dailyCountDate = :today AND dailyCount < :cap",
                ExpressionAttributeValues: { ":one": 1, ":today": today, ":cap": cap },
                ReturnValues: "UPDATED_NEW",
            }));

            return Number(result.Attributes?.dailyCount ?? 1);
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                return null;
            }

            throw error;
        }
    }

    /** Starts today's counter at one, but only while the stored counter is for another day. */
    private async restartCounter(userId: string, today: string): Promise<number | null> {
        try {
            const result = await this.documentClient.send(new UpdateCommand({
                TableName: this.tableName,
                Key: { userId },
                UpdateExpression: "SET dailyCount = :one, dailyCountDate = :today",
                ConditionExpression: "attribute_exists(userId) AND (attribute_not_exists(dailyCountDate) OR dailyCountDate <> :today)",
                ExpressionAttributeValues: { ":one": 1, ":today": today },
                ReturnValues: "UPDATED_NEW",
            }));

            return Number(result.Attributes?.dailyCount ?? 1);
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException) {
                return null;
            }

            throw error;
        }
    }
}
