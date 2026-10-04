/** Maps `items` through `task` running at most `limit` tasks at a time, preserving order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index], index);
        }
    });

    await Promise.all(workers);

    return results;
}
