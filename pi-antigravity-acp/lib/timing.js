/** Opt-in monotonic timings without prompt, argument, result, or credential data. */
import { performance } from 'node:perf_hooks';
let nextRequestId = 0;
/** One OMP stream request; all offsets are relative to its entry time. */
export class RequestTiming {
    log;
    started = performance.now();
    requestId = ++nextRequestId;
    seen = new Set();
    constructor(log) {
        this.log = log;
        this.mark('request_received');
    }
    mark(phase, detail = {}) {
        this.log(`antigravity-acp: timing ${JSON.stringify({
            requestId: this.requestId, phase,
            elapsedMs: Math.round((performance.now() - this.started) * 1000) / 1000,
            ...detail,
        })}`);
    }
    first(phase, detail) {
        if (this.seen.has(phase))
            return;
        this.seen.add(phase);
        this.mark(phase, detail);
    }
}
