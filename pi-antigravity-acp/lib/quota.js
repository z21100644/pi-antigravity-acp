/**
 * Plan quota read through the official CLI's local `/usage` command, which
 * reports each model group's weekly and five-hour windows without sending a
 * model request.
 * @module pi-antigravity-acp/quota
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
                if (typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)
                    || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1)
                    throw new Error(`Invalid quota fraction for ${String(bucket.id ?? 'unknown bucket')}`);
                return {
                    id: String(bucket.id ?? ''),
                    name: String(bucket.name ?? ''),
                    window: String(bucket.window ?? ''),
                    remainingFraction: bucket.remaining_fraction,
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
    lastAttemptAt = 0;
    latest;
    abort = new AbortController();
    /**
     * @param binary - returns the agy executable.
     * @param run - helper command runner.
     * @param ttlMs - cache lifetime.
     */
    constructor(binary, run, ttlMs, { cachePath, warn = () => undefined, now = Date.now } = {}) {
        this.binary = binary;
        this.run = run;
        this.ttlMs = ttlMs;
        this.cachePath = cachePath;
        this.warn = warn;
        this.now = now;
        if (cachePath !== undefined) {
            try {
                const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
                const groups = parseUsage(JSON.stringify({ command: { data: { groups: cached.groups?.map(group => ({
                    ...group, buckets: group.buckets.map(bucket => ({ ...bucket, remaining_fraction: bucket.remainingFraction, reset_time: bucket.resetTime })),
                })) } } }));
                const at = Date.parse(cached.updatedAt);
                if (cached.version !== 1 || !Number.isFinite(at) || at > this.now())
                    throw new Error('Invalid quota cache timestamp or version');
                this.cached = this.latest = { status: 'ok', updatedAt: cached.updatedAt, groups };
                this.cachedAt = at;
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    this.warn(`antigravity-acp: quota cache ignored: ${String(error)}`);
            }
        }
    }
    /**
     * Read the quota snapshot.
     * @param force - bypass the cache.
     * @returns the snapshot; failures resolve as `status: 'error'`.
     */
    async read(force = false) {
        if (this.abort.signal.aborted)
            return this.snapshot();
        if (this.inflight !== undefined)
            return this.inflight;
        // Calls from the GUI, model completion and manual refresh share one throttle.
        if (this.lastAttemptAt > 0 && this.now() - this.lastAttemptAt < 15_000)
            return this.snapshot();
        if (!force && this.cached !== undefined && this.now() - this.cachedAt < this.ttlMs)
            return this.snapshot();
        this.inflight ??= this.fetch().finally(() => { this.inflight = undefined; });
        return this.inflight;
    }
    async fetch() {
        this.lastAttemptAt = this.now();
        try {
            const binary = this.binary();
            if (binary === undefined)
                throw new Error('agy binary not resolved yet');
            const result = await this.run([binary, '-p', '/usage', '--output-format', 'json'], 45_000, { signal: this.abort.signal });
            if (result.code !== 0)
                throw new Error(`agy /usage exited ${result.code}: ${result.stderr.trim().slice(-400)}`);
            const snapshot = { status: 'ok', updatedAt: new Date(this.now()).toISOString(), groups: parseUsage(result.stdout) };
            if (this.abort.signal.aborted)
                return this.snapshot();
            this.cached = snapshot;
            this.latest = snapshot;
            this.cachedAt = this.now();
            if (this.cachePath !== undefined) {
                try {
                    mkdirSync(dirname(this.cachePath), { recursive: true });
                    const tmp = `${this.cachePath}.${process.pid}.tmp`;
                    writeFileSync(tmp, JSON.stringify({ version: 1, ...snapshot }));
                    renameSync(tmp, this.cachePath);
                }
                catch (error) {
                    this.warn(`antigravity-acp: quota cache could not be written: ${String(error)}`);
                }
            }
            return snapshot;
        }
        catch (error) {
            const snapshot = {
                status: 'error',
                updatedAt: this.cached?.updatedAt ?? null,
                groups: this.cached?.groups ?? [],
                error: error instanceof Error ? error.message : String(error),
            };
            this.latest = snapshot;
            if (!this.abort.signal.aborted)
                this.warn(`antigravity-acp: quota refresh failed: ${snapshot.error}`);
            return snapshot;
        }
    }
    snapshot() {
        return { ...(this.latest ?? { status: 'empty', groups: [], updatedAt: null }),
            refreshing: this.inflight !== undefined, stale: this.latest?.status === 'error' || !this.cached || this.now() - this.cachedAt >= this.ttlMs,
            refreshAllowedAt: this.lastAttemptAt > 0 ? this.lastAttemptAt + 15_000 : 0 };
    }
    dispose() { this.abort.abort(new Error('Quota reader disposed')); }
}
