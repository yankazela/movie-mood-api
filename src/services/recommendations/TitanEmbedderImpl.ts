import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { Embedder } from "./Embedder";
import { DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIMENSIONS } from "./config";

/** Embeds text with Amazon Titan Text Embeddings v2 on Bedrock. */
export class TitanEmbedderImpl implements Embedder {
    private readonly client: BedrockRuntimeClient;
    private readonly modelId: string;

    constructor(
        client: BedrockRuntimeClient = new BedrockRuntimeClient({}),
        modelId: string = process.env.EMBEDDING_MODEL_ID || DEFAULT_EMBEDDING_MODEL_ID,
    ) {
        this.client = client;
        this.modelId = modelId;
    }

    public async embed(text: string): Promise<number[]> {
        const response = await this.client.send(new InvokeModelCommand({
            modelId: this.modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
        }));

        const payload = JSON.parse(Buffer.from(response.body).toString("utf8")) as { embedding?: number[] };

        if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
            throw new Error(`Embedding model ${this.modelId} returned no embedding`);
        }

        return payload.embedding;
    }
}
