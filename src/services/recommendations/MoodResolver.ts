import { IMoodProfile } from "./domain/types";

export interface MoodResolver {
    /** Reads a free-text description of how someone feels into a structured mood profile. */
    resolve(text: string): Promise<IMoodProfile>;

    /** Identifier of the resolver, stored on the request for later analysis (e.g. "bedrock"). */
    readonly name: string;
}
