export interface Embedder {
    /** Embeds a sentence into the same vector space as the movie index. */
    embed(text: string): Promise<number[]>;
}
