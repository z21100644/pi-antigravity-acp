/** Durable ownership records for never-prompted sessions, separate from history. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Unknown or inaccessible process identity is treated as still alive. */
export function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
export class UnusedSessionLedger {
    warn;
    isAlive;
    owner = randomUUID();
    directory;
    constructor(home, warn, isAlive = processIsAlive) {
        this.warn = warn;
        this.isAlive = isAlive;
        this.directory = join(home, 'agy', 'pi-unused-sessions');
    }
    /** A crash during this write leaves an invalid record that recovery ignores. */
    track(sessionId, nativePid = process.pid) {
        if (!Number.isSafeInteger(nativePid) || nativePid <= 0)
            throw new Error('Invalid native ACP process id');
        const path = this.path(sessionId);
        mkdirSync(this.directory, { recursive: true });
        const record = { version: 1, owner: this.owner, ownerPid: process.pid, nativePid,
            sessionId, createdAt: Date.now() };
        writeFileSync(path, JSON.stringify(record), { flag: 'wx' });
    }
    ownedBy(sessionId, owner = this.owner) {
        const path = this.path(sessionId);
        if (!existsSync(path))
            return false;
        const record = this.read(path, sessionId);
        if (record.owner !== owner)
            throw new Error(`Unused-session ownership changed: ${sessionId}`);
        return true;
    }
    /** Must succeed immediately before the first prompt is submitted. */
    forget(sessionId, owner = this.owner) {
        if (!this.ownedBy(sessionId, owner))
            return;
        try {
            unlinkSync(this.path(sessionId));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    /** Scan ownership records only; an empty DB by itself grants no authority. */
    recoverable() {
        if (!existsSync(this.directory))
            return [];
        const result = [];
        for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json'))
                continue;
            const sessionId = entry.name.slice(0, -5);
            try {
                const record = this.read(this.path(sessionId), sessionId);
                if (!this.isAlive(record.ownerPid) && !this.isAlive(record.nativePid))
                    result.push(record);
            }
            catch (error) {
                this.warn(`antigravity-acp: unused session ownership record ignored (${entry.name}): ${String(error)}`);
            }
        }
        return result;
    }
    path(sessionId) {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
            throw new Error('Invalid unused ACP session id');
        return join(this.directory, `${sessionId}.json`);
    }
    read(path, sessionId) {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (record === null || typeof record !== 'object' || record.version !== 1 || record.sessionId !== sessionId
            || typeof record.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(record.owner)
            || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
            || !Number.isSafeInteger(record.nativePid) || record.nativePid <= 0
            || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt <= 0) {
            throw new Error('Invalid unused-session ownership record');
        }
        return record;
    }
}
