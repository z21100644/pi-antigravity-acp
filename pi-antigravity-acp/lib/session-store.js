/** Durable bindings adapted from dsh-plugin-bundle v0.4.0 (MIT). */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_SESSIONS = 128;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTool = tool => isObject(tool) && typeof tool.name === 'string'
    && typeof tool.description === 'string' && isObject(tool.inputSchema);
function validEntry(entry) {
    return isObject(entry) && typeof entry.sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(entry.sessionId)
        && typeof entry.workspace === 'string' && typeof entry.numericEnumMode === 'string'
        && typeof entry.systemHash === 'string' && /^[a-f0-9]{24}$/.test(entry.systemHash)
        && Array.isArray(entry.knownHistory) && entry.knownHistory.every(item => isObject(item)
            && typeof item.id === 'string' && typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint))
        && (entry.emittedAssistant === undefined || typeof entry.emittedAssistant === 'string' && /^[a-f0-9]{64}$/.test(entry.emittedAssistant))
        && Array.isArray(entry.advertisedTools) && entry.advertisedTools.every(isTool)
        && Array.isArray(entry.nativeToolBaselines) && entry.nativeToolBaselines.every(isTool)
        && Array.isArray(entry.knownTools) && entry.knownTools.every(pair => Array.isArray(pair)
            && typeof pair[0] === 'string' && isObject(pair[1]) && typeof pair[1].digest === 'string'
            && typeof pair[1].schemaDigest === 'string' && isObject(pair[1].schemaDescriptions))
        && Array.isArray(entry.issuedIds) && entry.issuedIds.every(id => typeof id === 'string')
        && Number.isFinite(entry.updatedAt);
}

export class SessionStore {
    entries = new Map();
    constructor(path, warn) {
        this.path = path;
        this.warn = warn;
        try {
            const data = JSON.parse(readFileSync(path, 'utf8'));
            if (!isObject(data) || data.version !== 1 || !isObject(data.entries))
                throw new Error('Unsupported session index format');
            for (const [key, entry] of Object.entries(data.entries)) {
                if (validEntry(entry))
                    this.entries.set(key, entry);
                else
                    this.warn(`antigravity-acp: invalid session index entry ignored (${key})`);
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                this.warn(`antigravity-acp: session index could not be read: ${String(error)}`);
        }
    }
    get(key) {
        return this.entries.get(key);
    }
    save(key, entry) {
        const next = new Map(this.entries);
        next.set(key, { ...entry, updatedAt: Date.now() });
        while (next.size > MAX_SESSIONS) {
            const oldest = [...next].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
            next.delete(oldest[0]);
        }
        return this.flush(next);
    }
    forget(key) {
        if (!this.entries.has(key))
            return true;
        const next = new Map(this.entries);
        next.delete(key);
        return this.flush(next);
    }
    flush(entries) {
        const tmp = `${this.path}.${process.pid}.tmp`;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }));
            renameSync(tmp, this.path);
            this.entries = entries;
            return true;
        }
        catch (error) {
            this.warn(`antigravity-acp: session index could not be written: ${String(error)}`);
            try {
                unlinkSync(tmp);
            }
            catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT')
                    this.warn(`antigravity-acp: session index temporary file retained: ${String(cleanupError)}`);
            }
            return false;
        }
    }
}
