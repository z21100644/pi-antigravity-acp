/**
 * Small async primitives shared by the adapter: deferred values, an
 * unbounded event queue with abortable waits, and a keyed mutex.
 * @module pi-antigravity-acp/util
 */
import { createHash } from 'node:crypto';
/**
 * Create a deferred value.
 * @returns the deferred handle.
 */
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // A rejection nobody awaits is expected when a parked call is abandoned.
    promise.catch(() => undefined);
    const handle = {
        promise,
        settled: false,
        resolve: (value) => { if (!handle.settled) {
            handle.settled = true;
            resolve(value);
        } },
        reject: (error) => { if (!handle.settled) {
            handle.settled = true;
            reject(error);
        } },
    };
    return handle;
}
/** Cancel one wait while allowing its shared operation to settle normally. */
export function withAbort(promise, signal) {
    if (signal === undefined)
        return promise;
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => { cleanup(); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        // Observe rejection even if cancellation wins, so shared startup failures
        // remain handled after the cancelled caller has already returned.
        void promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted)
            onAbort();
    });
}
/** Unbounded FIFO with one consumer that can wait with a deadline or abort signal. */
export class AsyncQueue {
    items = [];
    waiter;
    /**
     * Append one item.
     * @param item - the queued value.
     */
    push(item) {
        this.items.push(item);
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }
    /** Number of queued items. */
    get size() {
        return this.items.length;
    }
    /**
     * Inspect the head without removing it.
     * @returns the head item.
     */
    peek() {
        return this.items[0];
    }
    /**
     * Inspect the tail without removing it.
     * @returns the tail item.
     */
    peekLast() {
        return this.items[this.items.length - 1];
    }
    /**
     * Remove the head item.
     * @returns the head item.
     */
    shift() {
        return this.items.shift();
    }
    /**
     * Wait until an item is available.
     * @param signal - aborts the wait.
     * @param timeoutMs - resolve false after this delay.
     * @returns whether an item is available.
     */
    async wait(signal, timeoutMs) {
        if (this.items.length > 0)
            return true;
        if (signal?.aborted === true)
            return false;
        return new Promise((resolve) => {
            let timer;
            const finish = (value) => {
                if (timer !== undefined)
                    clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                if (this.waiter === wake)
                    this.waiter = undefined;
                resolve(value);
            };
            const wake = () => finish(true);
            const onAbort = () => finish(false);
            this.waiter = wake;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (timeoutMs !== undefined)
                timer = setTimeout(() => finish(this.items.length > 0), timeoutMs);
        });
    }
}
/** Serializes async sections per key. */
export class KeyedMutex {
    tails = new Map();
    /**
     * Acquire the lock for one key.
     * @param key - lock key.
     * @param signal - cancel this waiter without disturbing other owners.
     * @returns the release function.
     */
    async acquire(key, signal) {
        signal?.throwIfAborted();
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        const cleanup = () => {
            if (this.tails.get(key) === tail)
                this.tails.delete(key);
        };
        try {
            await withAbort(previous, signal);
            signal?.throwIfAborted();
        }
        catch (error) {
            // Resolve only our link. Successors still wait for the preceding owner.
            release();
            void tail.then(cleanup);
            throw error;
        }
        return () => { release(); cleanup(); };
    }
}
/**
 * Stable short digest of a JSON-serializable value.
 * @param value - hashed value.
 * @returns hex digest prefix.
 */
export function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
/** Hash JSON content independently of object property insertion order. */
export function contentDigest(value) {
    const serialized = JSON.stringify(value, (_key, entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
            return entry;
        const record = entry;
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    });
    return createHash('sha256').update(serialized).digest('hex');
}
/**
 * Sleep for a duration.
 * @param ms - delay.
 * @returns a promise resolved after the delay.
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
