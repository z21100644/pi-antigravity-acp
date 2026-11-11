/** Separate official subscription snapshots from per-request token accounting. */
const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const empty = () => Object.fromEntries(FIELDS.map(field => [field, 0]));
function add(target, usage) {
    for (const field of FIELDS) {
        if (Number.isFinite(usage[field]) && usage[field] >= 0)
            target[field] += usage[field];
    }
}

export class UsageMonitor {
    sessions = new Map();
    requests = new Map();
    revision = 0;
    disposed = false;
    constructor(quota, { now = Date.now, warn = () => undefined } = {}) {
        this.quota = quota;
        this.now = now;
        this.warn = warn;
        this.startedAt = new Date(now()).toISOString();
    }
    begin(id, request) {
        if (this.disposed || request.purpose !== 'main' || !request.sessionId)
            return;
        const session = this.sessions.get(request.sessionId) ?? {
            sessionId: request.sessionId, totals: empty(), requests: 0, exact: true, current: null,
        };
        const current = { id, model: request.model, status: 'generating', outputCharacters: 0, estimatedOutputTokens: 0,
            usage: null, exact: true, startedAt: new Date(this.now()).toISOString(), updatedAt: this.now() };
        session.current = current;
        this.sessions.delete(request.sessionId);
        this.sessions.set(request.sessionId, session);
        this.requests.set(id, { session, current });
        while (this.sessions.size > 64) {
            const idle = [...this.sessions].find(([, value]) => value.current?.status !== 'generating');
            if (!idle) break;
            this.sessions.delete(idle[0]);
        }
        this.revision++;
    }
    chunk(id, chunk) {
        const record = this.requests.get(id);
        if (!record) return;
        const { current, session } = record;
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            const text = chunk.text ?? '';
            current.outputCharacters += [...text].length;
            // A display estimate only; no quota fraction or billed counter is derived from it.
            current.estimatedOutputTokens += [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 1 : 0.25), 0);
        }
        else if (chunk.type === 'usage') {
            current.usage ??= empty();
            add(current.usage, chunk.usage);
            add(session.totals, chunk.usage);
            current.exact &&= chunk.exact === true;
            session.exact &&= chunk.exact === true;
        }
        else if (chunk.type === 'finish') {
            current.status = chunk.reason.kind === 'tool-calls' ? 'waiting_tools'
                : chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens' ? 'completed' : chunk.reason.kind;
        }
        current.updatedAt = this.now();
        this.revision++;
    }
    end(id, failure) {
        const record = this.requests.get(id);
        if (!record) return;
        this.requests.delete(id);
        const { current, session } = record;
        if (failure) {
            current.status = failure;
        }
        else if (current.status === 'generating') {
            current.status = 'error';
        }
        session.requests++;
        this.revision++;
        // Model/tool rounds coalesce into at most one official quota query per 15s.
        if (!this.refreshTimer && !this.disposed) {
            const wait = Math.max(0, this.quota.lastAttemptAt + 15_000 - this.now());
            this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refresh(true); }, wait);
            this.refreshTimer.unref?.();
        }
    }
    refresh(force = false) {
        if (this.disposed) return;
        void this.quota.read(force).catch(error => this.warn(`antigravity-acp: quota monitor failed: ${String(error)}`));
    }
    snapshot(sessionId, force = false) {
        this.refresh(force);
        const session = this.sessions.get(sessionId);
        return { version: 1, revision: this.revision, startedAt: this.startedAt, serverTime: this.now(),
            quota: this.quota.snapshot(), session: session ? structuredClone(session) : null };
    }
    dispose() {
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        this.requests.clear();
    }
}
