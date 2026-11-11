/**
 * Read generation bills and completed model-step usage written by `agy` into
 * `$home/agy/conversations/<sessionId>.db` (`gen_metadata.data` field `1.4`,
 * or `steps.metadata` field `9` for `step_type = 15`, `status = 3`).
 * @module omp-antigravity-acp/usage-db
 */
import { existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
let cachedDatabaseSync;
function loadDatabaseSync() {
    if (cachedDatabaseSync !== undefined)
        return cachedDatabaseSync ?? undefined;
    try {
        const req = createRequire(import.meta.url);
        const sqlite = req('node:sqlite');
        cachedDatabaseSync = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null;
    }
    catch {
        cachedDatabaseSync = null;
    }
    return cachedDatabaseSync ?? undefined;
}
/**
 * Resolve the SQLite conversation DB path for one ACP session.
 * @param home - isolated Antigravity home directory.
 * @param sessionId - ACP session id.
 * @returns absolute path to `<sessionId>.db`.
 */
export function sessionDbPath(home, sessionId) {
    return join(home, 'agy', 'conversations', `${sessionId}.db`);
}
/** Called only after an owned, never-prompted session acknowledged closure. */
export function removeEmptySessionDb(home, sessionId, cleanup = { mainRemoved: false }) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
        throw new Error('Invalid unused ACP session id');
    const path = sessionDbPath(home, sessionId);
    const Database = loadDatabaseSync();
    if (Database === undefined)
        return false;
    if (existsSync(path)) {
        const db = new Database(path, { readOnly: true, timeout: 100 });
        let empty = false;
        try {
            empty = db.prepare('SELECT COUNT(*) AS count FROM steps').get()?.['count'] === 0;
        }
        finally {
            db.close();
        }
        if (!empty)
            return false;
        // Never detach a WAL from a main DB whose deletion was denied by Windows.
        try {
            unlinkSync(path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        cleanup.mainRemoved = true;
    }
    else if (!cleanup.mainRemoved) {
        return false;
    }
    // Only this cleanup's successful main-file deletion authorizes sidecar retries.
    for (const file of [`${path}-wal`, `${path}-shm`]) {
        try {
            unlinkSync(file);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    return true;
}
function readVarint(buf, offset) {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
        const byte = buf[offset + i];
        if (byte === undefined)
            return undefined;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            return { value, next: offset + i + 1 };
        shift += 7n;
    }
    return undefined;
}
function toNonNegativeCount(raw) {
    const signed = BigInt.asIntN(64, raw);
    if (signed <= 0n)
        return 0;
    if (signed > BigInt(Number.MAX_SAFE_INTEGER))
        return Number.MAX_SAFE_INTEGER;
    return Number(signed);
}
function parseModelUsageSubmessage(buf, target) {
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (tag === undefined)
            return false;
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 7n);
        if (field <= 0)
            return false;
        switch (wire) {
            case 0: {
                const val = readVarint(buf, pos);
                if (val === undefined)
                    return false;
                pos = val.next;
                const count = toNonNegativeCount(val.value);
                if (field === 2)
                    target.inputTokens = count;
                else if (field === 3)
                    target.outputTokens = count;
                else if (field === 4)
                    target.cachedWriteTokens = count;
                else if (field === 5)
                    target.cachedReadTokens = count;
                else if (field === 9)
                    target.thoughtTokens = count;
                break;
            }
            case 1:
                if (pos + 8 > buf.length)
                    return false;
                pos += 8;
                break;
            case 2: {
                const len = readVarint(buf, pos);
                if (len === undefined)
                    return false;
                const byteLen = Number(len.value);
                if (len.value < 0n || !Number.isSafeInteger(byteLen) || len.next + byteLen > buf.length)
                    return false;
                pos = len.next + byteLen;
                break;
            }
            case 5:
                if (pos + 4 > buf.length)
                    return false;
                pos += 4;
                break;
            default:
                return false;
        }
    }
    return true;
}
/**
 * Decode `ModelUsageStats` (top-level field `9`, wire type `2`) from a `steps.metadata` blob.
 * @param metadata - raw Protobuf bytes from `steps.metadata`.
 * @returns decoded token counts, or `undefined` if field `9` is absent or malformed.
 */
export function decodeModelUsageStats(metadata) {
    let pos = 0;
    let found = false;
    const stats = {
        inputTokens: 0,
        outputTokens: 0,
        cachedWriteTokens: 0,
        cachedReadTokens: 0,
        thoughtTokens: 0,
    };
    while (pos < metadata.length) {
        const tag = readVarint(metadata, pos);
        if (tag === undefined)
            return undefined;
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 7n);
        if (field <= 0)
            return undefined;
        switch (wire) {
            case 0: {
                const val = readVarint(metadata, pos);
                if (val === undefined)
                    return undefined;
                pos = val.next;
                break;
            }
            case 1:
                if (pos + 8 > metadata.length)
                    return undefined;
                pos += 8;
                break;
            case 2: {
                const len = readVarint(metadata, pos);
                if (len === undefined)
                    return undefined;
                const byteLen = Number(len.value);
                if (len.value < 0n || !Number.isSafeInteger(byteLen) || len.next + byteLen > metadata.length)
                    return undefined;
                if (field === 9) {
                    const sub = metadata.subarray(len.next, len.next + byteLen);
                    if (!parseModelUsageSubmessage(sub, stats))
                        return undefined;
                    found = true;
                }
                pos = len.next + byteLen;
                break;
            }
            case 5:
                if (pos + 4 > metadata.length)
                    return undefined;
                pos += 4;
                break;
            default:
                return undefined;
        }
    }
    return found ? stats : undefined;
}
/**
 * Read the current maximum completed model-step index (`step_type = 15, status = 3`).
 * @param dbPath - path to `<sessionId>.db`.
 * @returns maximum step `idx`, or `-1` when absent or empty.
 */
export function peekMaxModelStepIdx(dbPath) {
    if (!existsSync(dbPath))
        return -1;
    const Database = loadDatabaseSync();
    if (Database === undefined)
        return -1;
    try {
        const db = new Database(dbPath, { readOnly: true, timeout: 100 });
        try {
            const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE step_type = 15 AND status = 3').get();
            const raw = row?.['maxIdx'];
            if (typeof raw === 'number' && Number.isFinite(raw))
                return raw;
            if (typeof raw === 'bigint')
                return Number(raw);
            return -1;
        }
        finally {
            db.close();
        }
    }
    catch {
        return -1;
    }
}
/**
 * Read and sum all completed model steps (`step_type = 15, status = 3`) after `afterIdx`.
 * @param dbPath - path to `<sessionId>.db`.
 * @param afterIdx - exclusive lower-bound step `idx`.
 * @returns aggregated batch, or `undefined` when no valid model steps exist after `afterIdx`.
 */
export function readModelStepsAfter(dbPath, afterIdx) {
    if (!existsSync(dbPath))
        return undefined;
    const Database = loadDatabaseSync();
    if (Database === undefined)
        return undefined;
    try {
        const db = new Database(dbPath, { readOnly: true, timeout: 100 });
        try {
            const rows = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx ASC').all(afterIdx);
            let maxIdx = afterIdx;
            let calls = 0;
            let inputTokens = 0;
            let outputTokens = 0;
            let cachedReadTokens = 0;
            let cachedWriteTokens = 0;
            let thoughtTokens = 0;
            for (const row of rows) {
                const rawIdx = row['idx'];
                const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx)
                    ? rawIdx
                    : typeof rawIdx === 'bigint'
                        ? Number(rawIdx)
                        : undefined;
                const rawMeta = row['metadata'];
                const bytes = rawMeta instanceof Uint8Array
                    ? rawMeta
                    : ArrayBuffer.isView(rawMeta)
                        ? new Uint8Array(rawMeta.buffer, rawMeta.byteOffset, rawMeta.byteLength)
                        : undefined;
                if (idx === undefined || bytes === undefined)
                    continue;
                const decoded = decodeModelUsageStats(bytes);
                if (decoded === undefined)
                    continue;
                if (idx > maxIdx)
                    maxIdx = idx;
                calls++;
                inputTokens += decoded.inputTokens;
                outputTokens += decoded.outputTokens;
                cachedReadTokens += decoded.cachedReadTokens;
                cachedWriteTokens += decoded.cachedWriteTokens;
                thoughtTokens += decoded.thoughtTokens;
            }
            if (calls === 0)
                return undefined;
            return {
                maxIdx,
                calls,
                usage: {
                    inputTokens,
                    outputTokens,
                    cachedReadTokens,
                    cachedWriteTokens,
                    thoughtTokens,
                    totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
                },
            };
        }
        finally {
            db.close();
        }
    }
    catch {
        return undefined;
    }
}

/** Validate a Protobuf message while retaining fields needed by the generation decoder. */
function protoFields(buf) {
    const fields = new Map();
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (tag === undefined || tag.value >> 3n === 0n)
            return undefined;
        pos = tag.next;
        const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
        if (wire === 0) {
            const value = readVarint(buf, pos);
            if (value === undefined)
                return undefined;
            fields.set(field, { wire, value: value.value });
            pos = value.next;
        }
        else if (wire === 1 || wire === 5) {
            pos += wire === 1 ? 8 : 4;
            if (pos > buf.length)
                return undefined;
        }
        else if (wire === 2) {
            const length = readVarint(buf, pos);
            if (length === undefined || length.value > BigInt(buf.length - length.next))
                return undefined;
            const end = length.next + Number(length.value);
            fields.set(field, { wire, bytes: buf.subarray(length.next, end) });
            pos = end;
        }
        else {
            return undefined;
        }
    }
    return fields;
}
function emptyUsage() {
    return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 };
}
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens'];
/** Generation field paths follow dsh-plugin-bundle v0.4.0 (MIT). */
export function decodeGenMetadata(data) {
    const chatBytes = protoFields(data)?.get(1)?.bytes;
    if (chatBytes === undefined)
        return undefined;
    const chat = protoFields(chatBytes);
    if (chat === undefined)
        return undefined;
    const usageBytes = chat.get(4)?.bytes;
    const stats = emptyUsage();
    if (usageBytes !== undefined && !parseModelUsageSubmessage(usageBytes, stats))
        return undefined;
    const start = chat.get(9)?.bytes;
    const context = start === undefined ? undefined : protoFields(start)?.get(10)?.bytes;
    const estimate = context === undefined ? undefined : protoFields(context)?.get(1);
    const cwmEstTokens = estimate?.wire === 0 ? toNonNegativeCount(estimate.value) : undefined;
    if (usageBytes === undefined && cwmEstTokens === undefined)
        return undefined;
    return { ...stats, ...(cwmEstTokens !== undefined ? { cwmEstTokens } : {}) };
}
function bytesOf(value) {
    return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined;
}
function usageSnapshot(dbPath) {
    if (!existsSync(dbPath))
        return undefined;
    const Database = loadDatabaseSync();
    if (Database === undefined)
        throw new Error('node:sqlite is unavailable');
    const db = new Database(dbPath, { readOnly: true, timeout: 100 });
    try {
        // Both tables must describe one SQLite snapshot, including a concurrent WAL commit.
        db.exec('BEGIN');
        const steps = db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 ORDER BY idx').all()
            .flatMap(row => {
                const bytes = bytesOf(row.metadata);
                const usage = bytes === undefined ? undefined : decodeModelUsageStats(bytes);
                return usage === undefined ? [] : [{ idx: Number(row.idx), ...usage }];
            });
        const hasGen = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'").get() !== undefined;
        const generations = hasGen ? db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all()
            .flatMap(row => {
                const bytes = bytesOf(row.data);
                const usage = bytes === undefined ? undefined : decodeGenMetadata(bytes);
                return usage === undefined || !TOKEN_FIELDS.some(field => usage[field] > 0)
                    ? [] : [{ idx: Number(row.idx), ...usage }];
            }) : undefined;
        return { steps, generations };
    }
    finally {
        db.close();
    }
}
/** Count identical bills by occurrence; equal token counts can belong to several calls. */
function billsByUsage(records) {
    const bills = new Map();
    for (const record of records) {
        const key = JSON.stringify(TOKEN_FIELDS.map(field => record[field]));
        const group = bills.get(key) ?? { count: 0, usage: record };
        group.count++;
        bills.set(key, group);
    }
    return bills;
}
/**
 * A session's generation bills and completed-step fallback share one accounting ledger.
 * Re-read records rather than assuming either table's indices or completion order match.
 * A late generation that matches a back-filled step consumes the same occurrence.
 */
export class SessionUsageReader {
    reported = new Map();
    lastError;
    constructor(dbPath, warn = () => undefined) {
        this.dbPath = dbPath;
        this.warn = warn;
        this.primed = !existsSync(dbPath);
        const snapshot = this.snapshot();
        if (snapshot !== undefined)
            this.prime(snapshot);
    }
    prime(snapshot) {
        const steps = billsByUsage(snapshot.steps), generations = billsByUsage(snapshot.generations ?? []);
        for (const [key, group] of [...steps, ...generations])
            this.reported.set(key, Math.max(group.count, this.reported.get(key) ?? 0));
        this.primed = true;
    }
    snapshot() {
        try {
            const snapshot = usageSnapshot(this.dbPath);
            this.lastError = undefined;
            return snapshot;
        }
        catch (error) {
            const message = String(error);
            if (message !== this.lastError)
                this.warn(`antigravity-acp: usage DB unavailable (${this.dbPath}); falling back to ACP usage: ${message}`);
            this.lastError = message;
            return undefined;
        }
    }
    read(final = false) {
        const snapshot = this.snapshot();
        if (snapshot === undefined)
            return undefined;
        if (!this.primed) {
            // A locked restored DB must never cause its historical bills to be re-emitted.
            // The native ACP fallback covers this first request while the baseline recovers.
            this.prime(snapshot);
            return undefined;
        }
        const steps = billsByUsage(snapshot.steps);
        const generations = billsByUsage(snapshot.generations ?? []);
        const eligible = snapshot.generations === undefined ? steps : new Map(generations);
        if (final && snapshot.generations !== undefined) {
            for (const [key, group] of steps) {
                if (group.count > (eligible.get(key)?.count ?? 0))
                    eligible.set(key, group);
            }
        }
        const usage = emptyUsage();
        let calls = 0, backfilled = 0;
        for (const [key, group] of eligible) {
            const count = Math.max(0, group.count - (this.reported.get(key) ?? 0));
            if (count === 0)
                continue;
            calls += count;
            if (snapshot.generations !== undefined && group.count > (generations.get(key)?.count ?? 0))
                backfilled += count;
            for (const field of TOKEN_FIELDS)
                usage[field] += group.usage[field] * count;
            this.reported.set(key, group.count);
        }
        if (calls === 0)
            return undefined;
        usage.totalTokens = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens + usage.outputTokens;
        if (backfilled > 0)
            this.warn(`antigravity-acp: usage-gap ${this.dbPath}: back-filled ${backfilled} completed model step(s)`);
        return { calls, usage, exact: true };
    }
}
