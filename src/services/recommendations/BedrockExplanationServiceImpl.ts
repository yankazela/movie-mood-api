import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ExplanationService } from "./ExplanationService";
import { EObjective, IMoodProfile } from "./domain/types";
import { DEFAULT_MOOD_MODEL_ID, WHY_STALE_DAYS } from "./config";
import { ICatalogItem, IWhyEntry } from "../catalog/domain/items";
import { CatalogItemRepository } from "../catalog/store/CatalogItemRepository";
import { CatalogStore } from "../catalog/store/CatalogStore";
import { nounFor } from "../media/MediaType";

const WhyLinesSchema = z.object({
    lines: z.array(z.object({
        itemId: z.string(),
        text: z.string().min(1).describe("One warm, specific sentence of at most 30 words; no spoilers"),
    })),
});

const SYSTEM_PROMPT = [
    "You write one sentence per title (a film, series, documentary, album or book, as stated) explaining why it",
    "suits someone in the described mood and with the described goal.",
    "Be warm and specific to the title, at most 30 words, no spoilers, no lists.",
    "Always respond by calling the why_lines tool exactly once, with one entry for every itemId you were given.",
].join(" ");

/** Cache key in an item's `why` map. */
export function whyKey(mood: IMoodProfile, objective: EObjective): string {
    return `${mood.primary_emotion}#${objective}`;
}

export class BedrockExplanationServiceImpl implements ExplanationService {
    private readonly client: AnthropicBedrock;
    private readonly modelId: string;
    private readonly catalogStore: CatalogItemRepository;
    private readonly tool: Anthropic.Tool;

    constructor(
        catalogStore: CatalogItemRepository = CatalogStore.fromEnvironment(),
        client: AnthropicBedrock = new AnthropicBedrock(),
        modelId: string = process.env.MOOD_MODEL_ID || DEFAULT_MOOD_MODEL_ID,
    ) {
        this.catalogStore = catalogStore;
        this.client = client;
        this.modelId = modelId;

        const { $schema, ...inputSchema } = z.toJSONSchema(WhyLinesSchema) as Record<string, unknown>;

        this.tool = {
            name: "why_lines",
            description: "Record one explanation line per title.",
            input_schema: inputSchema as Anthropic.Tool.InputSchema,
        };
    }

    public async explain(items: ICatalogItem[], mood: IMoodProfile, objective: EObjective): Promise<Map<string, string>> {
        const key = whyKey(mood, objective);
        const staleBefore = Date.now() - WHY_STALE_DAYS * 24 * 60 * 60 * 1000;
        const lines = new Map<string, string>();
        const missing: ICatalogItem[] = [];

        for (const item of items) {
            const cached = item.why?.[key];

            if (cached && Date.parse(cached.at) >= staleBefore) {
                lines.set(item.itemId, cached.text);
            } else {
                missing.push(item);
            }
        }

        if (missing.length === 0) {
            return lines;
        }

        const generated = await this.generate(missing, mood, objective);
        const at = new Date().toISOString();

        const writes = await Promise.allSettled(
            [...generated].map(([itemId, text]) => {
                lines.set(itemId, text);
                const entry: IWhyEntry = { text, model: this.modelId, at };

                return this.catalogStore.saveWhy(itemId, key, entry);
            }),
        );

        for (const write of writes) {
            if (write.status === "rejected") {
                console.error("Failed to cache a why line:", (write.reason as Error)?.message);
            }
        }

        return lines;
    }

    private async generate(items: ICatalogItem[], mood: IMoodProfile, objective: EObjective): Promise<Map<string, string>> {
        const goal = objective === EObjective.IMPROVE ? "wants to feel a bit lighter" : "wants something that matches the mood";
        const prompt = [
            `The viewer feels ${mood.primary_emotion} and ${goal}.`,
            mood.themes_seek.length ? `They are drawn to: ${mood.themes_seek.join(", ")}.` : "",
            mood.themes_avoid.length ? `They want to avoid: ${mood.themes_avoid.join(", ")}.` : "",
            "",
            "Titles:",
            ...items.map(item => [
                `- itemId: ${item.itemId}`,
                `  type: ${nounFor(item.mediaType)}`,
                `  title: ${item.title}${item.year ? ` (${item.year})` : ""}`,
                item.genres?.length ? `  genres: ${item.genres.join(", ")}` : "",
                item.moodDesc ? `  mood: ${item.moodDesc}` : "",
            ].filter(Boolean).join("\n")),
        ].filter(line => line !== undefined).join("\n");

        const response = await this.client.messages.create({
            model: this.modelId,
            max_tokens: 16000,
            // No output_config.effort: Haiku 4.5 rejects it. On 4.6+ models you can add { effort: "low" }.
            system: SYSTEM_PROMPT,
            tools: [this.tool],
            tool_choice: { type: "tool", name: this.tool.name },
            messages: [{ role: "user", content: prompt }],
        });

        const toolUse = response.content.find(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === this.tool.name,
        );
        const parsed = toolUse ? WhyLinesSchema.safeParse(toolUse.input) : undefined;

        if (!parsed?.success) {
            // Explanations are a nicety: log and return none rather than failing the recommendation.
            console.error("Explanation model returned no usable why lines", parsed?.error?.message ?? response.stop_reason);

            return new Map();
        }

        const wanted = new Set(items.map(item => item.itemId));

        return new Map(parsed.data.lines.filter(line => wanted.has(line.itemId)).map(line => [line.itemId, line.text]));
    }
}
