import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { IMoodSource, MoodDescriber } from "./MoodDescriber";
import { DEFAULT_MOOD_MODEL_ID } from "../recommendations/config";

const DescriptionsSchema = z.object({
    descriptions: z.array(z.object({
        movieId: z.string(),
        moodDesc: z.string().min(1).describe("Two or three sentences on how the film feels to watch"),
    })),
});

const SYSTEM_PROMPT = [
    "For each film, write two or three sentences describing how it feels to watch: its emotional tone,",
    "its energy level, the themes it dwells on, and the moods it suits or lifts.",
    "Be concrete and plain; mention plot only as far as needed to convey the feeling, and never spoil endings.",
    "Always respond by calling the mood_descriptions tool exactly once, with one entry for every movieId given.",
].join(" ");

/** Writes mood descriptions with Claude on Bedrock. These feed the embeddings and the why lines. */
export class BedrockMoodDescriberImpl implements MoodDescriber {
    private readonly client: AnthropicBedrock;
    private readonly modelId: string;
    private readonly tool: Anthropic.Tool;

    constructor(
        client: AnthropicBedrock = new AnthropicBedrock(),
        modelId: string = process.env.MOOD_MODEL_ID || DEFAULT_MOOD_MODEL_ID,
    ) {
        this.client = client;
        this.modelId = modelId;

        const { $schema, ...inputSchema } = z.toJSONSchema(DescriptionsSchema) as Record<string, unknown>;

        this.tool = {
            name: "mood_descriptions",
            description: "Record a mood description per film.",
            input_schema: inputSchema as Anthropic.Tool.InputSchema,
        };
    }

    public async describe(movies: IMoodSource[]): Promise<Map<string, string>> {
        if (movies.length === 0) {
            return new Map();
        }

        const prompt = movies.map(movie => [
            `- movieId: ${movie.movieId}`,
            `  title: ${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
            movie.genres.length ? `  genres: ${movie.genres.join(", ")}` : "",
            movie.keywords.length ? `  keywords: ${movie.keywords.slice(0, 12).join(", ")}` : "",
            `  overview: ${movie.overview}`,
        ].filter(Boolean).join("\n")).join("\n");

        const response = await this.client.messages.create({
            model: this.modelId,
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            tools: [this.tool],
            tool_choice: { type: "tool", name: this.tool.name },
            messages: [{ role: "user", content: `Films:\n${prompt}` }],
        });

        const toolUse = response.content.find(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === this.tool.name,
        );
        const parsed = toolUse ? DescriptionsSchema.safeParse(toolUse.input) : undefined;

        if (!parsed?.success) {
            throw new Error(`Mood describer returned no usable descriptions: ${parsed?.error?.message ?? response.stop_reason}`);
        }

        const wanted = new Set(movies.map(movie => movie.movieId));

        return new Map(parsed.data.descriptions
            .filter(entry => wanted.has(entry.movieId))
            .map(entry => [entry.movieId, entry.moodDesc.trim()]));
    }
}
