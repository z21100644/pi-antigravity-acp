/**
 * Plan quota read through the official CLI's local `/usage` command, which
 * reports each model group's weekly and five-hour windows without sending a
 * model request.
 * @module omp-antigravity-acp/quota
 */
/**
 * Parse `agy -p /usage --output-format json` output.
 * @param stdout - command stdout.
 * @returns the quota groups.
 */
export function parseUsage(stdout) {
    const parsed = JSON.parse(stdout);
    const groups = parsed.command?.data?.groups;
    if (!Array.isArray(groups))
        throw new Error('agy /usage returned no quota groups');
    return groups.map((raw) => {
        const group = raw;
        return {
            name: String(group.name ?? ''),
            description: String(group.description ?? ''),
            buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((b) => {
                const bucket = b;
                return {
                    id: String(bucket.id ?? ''),
                    name: String(bucket.name ?? ''),
                    window: String(bucket.window ?? ''),
                    remainingFraction: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0,
                    resetTime: String(bucket.reset_time ?? ''),
                };
            }),
        };
    });
}
/**
 * Pick the quota group that serves one model family.
 * @param groups - quota groups.
 * @param model - model family id.
 * @returns the matching group.
 */
export function groupForModel(groups, model) {
    const gemini = /gemini/i.test(model);
    return groups.find(g => gemini ? /gemini/i.test(g.name) : !/gemini/i.test(g.name)) ?? groups[0];
}
/** Cached quota reader with request coalescing. */
export class QuotaReader {
    binary;
    run;
    ttlMs;
    cached;
    cachedAt = 0;
    inflight;
    /**
     * @param binary - returns the agy executable.
     * @param cwd - working directory for the command.
     * @param run - helper command runner.
     * @param ttlMs - cache lifetime.
     */
    constructor(binary, run, ttlMs) {
        this.binary = binary;
        this.run = run;
        this.ttlMs = ttlMs;
    }
    /**
     * Read the quota snapshot.
     * @param force - bypass the cache.
     * @returns the snapshot; failures resolve as `status: 'error'`.
     */
    async read(force = false) {
        if (!force && this.cached !== undefined && Date.now() - this.cachedAt < this.ttlMs)
            return this.cached;
        this.inflight ??= this.fetch().finally(() => { this.inflight = undefined; });
        return this.inflight;
    }
    async fetch() {
        const binary = this.binary();
        if (binary === undefined)
            return { status: 'error', updatedAt: new Date().toISOString(), groups: [], error: 'agy binary not resolved yet' };
        try {
            const result = await this.run([binary, '-p', '/usage', '--output-format', 'json'], 45_000);
            const snapshot = { status: 'ok', updatedAt: new Date().toISOString(), groups: parseUsage(result.stdout) };
            this.cached = snapshot;
            this.cachedAt = Date.now();
            return snapshot;
        }
        catch (error) {
            const snapshot = {
                status: 'error',
                updatedAt: new Date().toISOString(),
                groups: this.cached?.groups ?? [],
                error: error instanceof Error ? error.message : String(error),
            };
            return snapshot;
        }
    }
}
