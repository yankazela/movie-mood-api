import { DeleteVectorsCommand, PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { DocumentType } from "@smithy/types";
import { IVectorMatch, IVectorRecord, VectorFilter, VectorIndex, VectorMetadata } from "./VectorIndex";

/** S3 Vectors accepts at most this many vectors per PutVectors or DeleteVectors call. */
const BATCH_LIMIT = 500;

/**
 * Movie vectors in an Amazon S3 Vectors index. The index is created by the storage stack with
 * float32 vectors, cosine distance and the embedder's dimension count.
 */
export class S3VectorsIndexImpl implements VectorIndex {
    private readonly client: S3VectorsClient;
    private readonly bucketName: string;
    private readonly indexName: string;

    constructor(client: S3VectorsClient, bucketName: string, indexName: string) {
        this.client = client;
        this.bucketName = bucketName;
        this.indexName = indexName;
    }

    /** Builds a client from VECTOR_BUCKET_NAME and VECTOR_INDEX_NAME, or null when they are unset. */
    public static fromEnvironment(): S3VectorsIndexImpl | null {
        const bucketName = process.env.VECTOR_BUCKET_NAME;
        const indexName = process.env.VECTOR_INDEX_NAME;

        if (!bucketName || !indexName) {
            return null;
        }

        return new S3VectorsIndexImpl(new S3VectorsClient({}), bucketName, indexName);
    }

    public async upsert(records: IVectorRecord[]): Promise<void> {
        for (let start = 0; start < records.length; start += BATCH_LIMIT) {
            const batch = records.slice(start, start + BATCH_LIMIT);

            await this.client.send(new PutVectorsCommand({
                vectorBucketName: this.bucketName,
                indexName: this.indexName,
                vectors: batch.map(record => ({
                    key: record.key,
                    data: { float32: record.vector },
                    metadata: record.metadata as DocumentType,
                })),
            }));
        }
    }

    public async query(vector: number[], filter: VectorFilter | undefined, topK: number): Promise<IVectorMatch[]> {
        const result = await this.client.send(new QueryVectorsCommand({
            vectorBucketName: this.bucketName,
            indexName: this.indexName,
            queryVector: { float32: vector },
            topK,
            filter: filter as DocumentType | undefined,
            returnDistance: true,
            returnMetadata: true,
        }));

        return (result.vectors ?? [])
            .filter(match => match.key)
            .map(match => ({
                key: match.key as string,
                distance: match.distance ?? 0,
                metadata: (match.metadata as VectorMetadata | undefined) ?? {},
            }));
    }

    public async delete(keys: string[]): Promise<void> {
        for (let start = 0; start < keys.length; start += BATCH_LIMIT) {
            await this.client.send(new DeleteVectorsCommand({
                vectorBucketName: this.bucketName,
                indexName: this.indexName,
                keys: keys.slice(start, start + BATCH_LIMIT),
            }));
        }
    }
}
