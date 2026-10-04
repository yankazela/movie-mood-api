import { HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AssetStore } from "./AssetStore";

/** Posters and provider logos in the project's S3 bucket. */
export class S3AssetStoreImpl implements AssetStore {
    private readonly client: S3Client;
    private readonly bucketName: string;
    private readonly fetchImpl: typeof fetch;

    constructor(
        client: S3Client = new S3Client({}),
        bucketName: string = process.env.ASSETS_BUCKET_NAME || "",
        fetchImpl: typeof fetch = fetch,
    ) {
        this.client = client;
        this.bucketName = bucketName;
        this.fetchImpl = fetchImpl;
    }

    public async ensureFromUrl(url: string, key: string): Promise<string> {
        if (await this.exists(key)) {
            return key;
        }

        const response = await this.fetchImpl(url);

        if (!response.ok) {
            throw new Error(`Could not download ${url}: HTTP ${response.status}`);
        }

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            Body: Buffer.from(await response.arrayBuffer()),
            ContentType: response.headers.get("content-type") ?? "application/octet-stream",
        }));

        return key;
    }

    private async exists(key: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
            return true;
        } catch (error) {
            if (error instanceof NotFound || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
                return false;
            }

            throw error;
        }
    }
}
