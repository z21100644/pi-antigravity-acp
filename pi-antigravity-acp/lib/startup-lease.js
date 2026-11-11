import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
function ownerAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
/** Atomic creation handles concurrent GUI sidecars without sharing their histories. */
export function acquireStartupLease(home) {
    mkdirSync(home, { recursive: true });
    const path = join(home, 'startup-warmup.lock');
    const contents = JSON.stringify({ version: 1, pid: process.pid, nonce: randomBytes(16).toString('hex') });
    for (let attempt = 0; attempt < 2; attempt++) {
        let fd;
        try {
            fd = openSync(path, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            let existing;
            let owner;
            try {
                existing = readFileSync(path, 'utf8');
                owner = JSON.parse(existing);
            }
            catch (readError) {
                if (readError.code === 'ENOENT')
                    continue;
                // A creator can be between open and write. Leave incomplete/unknown files alone.
                return undefined;
            }
            if (owner === null || typeof owner !== 'object' || owner.version !== 1
                || typeof owner.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(owner.nonce) || ownerAlive(owner.pid))
                return undefined;
            // Do not remove a successor's lease after recovering a dead owner.
            // Serialize reclaimers of this exact dead nonce. A regular creator can
            // win after removal, but a second stale reader can never unlink it.
            const reclaimPath = `${path}.reclaim.${owner.nonce}`;
            let reclaim;
            try {
                reclaim = openSync(reclaimPath, 'wx', 0o600);
            }
            catch (reclaimError) {
                if (reclaimError.code === 'EEXIST')
                    return undefined;
                throw reclaimError;
            }
            try {
                try {
                    if (readFileSync(path, 'utf8') === existing)
                        unlinkSync(path);
                }
                catch (unlinkError) {
                    if (unlinkError.code !== 'ENOENT')
                        throw unlinkError;
                }
            }
            finally {
                closeSync(reclaim);
                unlinkSync(reclaimPath);
            }
            continue;
        }
        try {
            writeFileSync(fd, contents);
        }
        finally {
            closeSync(fd);
        }
        return { release: () => {
                try {
                    if (readFileSync(path, 'utf8') === contents)
                        unlinkSync(path);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
            } };
    }
    return undefined;
}
