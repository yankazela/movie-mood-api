import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MovieRepository } from "./MovieRepository";
import { IMovie, IWhyEntry } from "./domain/types";

/** DynamoDB allows at most this many keys per BatchGetItem. */
const BATCH_GET_LIMIT = 100;
const UNPROCESSED_RETRIES = 3;

export class MovieRepositoryImpl implements MovieRepository {
    private readonly documentClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(
        documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
            marshallOptions: { removeUndefinedValues: true },
        }),
        tableName: string = process.env.MOVIES_TABLE_NAME || "",
    ) {
        this.documentClient = documentClient;
        this.tableName = tableName;
    }

    public async findByIds(movieIds: string[]): Promise<IMovie[]> {
        const unique = [...new Set(movieIds)];
        const movies: IMovie[] = [];

        for (let start = 0; start < unique.length; start += BATCH_GET_LIMIT) {
            let keys = unique.slice(start, start + BATCH_GET_LIMIT).map(movieId => ({ movieId }));

            for (let attempt = 0; keys.length > 0 && attempt <= UNPROCESSED_RETRIES; attempt++) {
                const result = await this.documentClient.send(new BatchGetCommand({
                    RequestItems: { [this.tableName]: { Keys: keys } },
                }));

                movies.push(...((result.Responses?.[this.tableName] as IMovie[] | undefined) ?? []));
                keys = (result.UnprocessedKeys?.[this.tableName]?.Keys as { movieId: string }[] | undefined) ?? [];
            }

            if (keys.length > 0) {
                console.warn(`Movies table left ${keys.length} keys unprocessed after ${UNPROCESSED_RETRIES} retries`);
            }
        }

        return movies;
    }

    public async upsertCatalog(movie: Omit<IMovie, "why">): Promise<void> {
        const fields = Object.entries(movie).filter(([name, value]) => name !== "movieId" && value !== undefined);
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
            Key: { movieId: movie.movieId },
            UpdateExpression: `SET ${assignments.join(", ")}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        }));
    }

    public async saveWhy(movieId: string, key: string, entry: IWhyEntry): Promise<void> {
        // A nested SET fails when the parent map does not exist yet, so make sure it does first.
        await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { movieId },
            UpdateExpression: "SET #why = if_not_exists(#why, :empty)",
            ConditionExpression: "attribute_exists(movieId)",
            ExpressionAttributeNames: { "#why": "why" },
            ExpressionAttributeValues: { ":empty": {} },
        }));

        await this.documentClient.send(new UpdateCommand({
            TableName: this.tableName,
            Key: { movieId },
            UpdateExpression: "SET #why.#key = :entry",
            ExpressionAttributeNames: { "#why": "why", "#key": key },
            ExpressionAttributeValues: { ":entry": entry },
        }));
    }
}
