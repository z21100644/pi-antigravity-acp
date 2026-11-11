/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto OMP model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a OMP tool
 * through the MCP bridge, the call parks, and the pump ends the current OMP
 * step with `finish(tool-calls)`. OMP runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that outlive the agent's MCP
 * deadline are relayed through the `omp_await_result` tool.
 * @module omp-antigravity-acp/conversation
 */
import { LlmError, ToolCallId } from "./protocol.js";
import { AGENT_TOOL_PREFIX, CALL_TOOL_NAME } from "./history.js";
import { AsyncQueue, deferred } from "./util.js";
export { CALL_TOOL_NAME };
/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*API error \(attempt \d+\)/;
/** Provider failure notice that agy can emit before returning `end_turn`. */
const AGENT_EXECUTION_ERROR_NOTICE = '⚠ Agent execution terminated due to error.';
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD = 'your previous response was cut off because it exceeded the output token limit';
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL = 'please continue from where you left off, keeping your response shorter';
/** Collapse agy's warning mark and line breaks so the notice can be recognized across chunks. */
function noticeText(raw) {
    return raw.replace(/⚠/g, ' ').replace(/\bError:/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
/**
 * Classify text against agy's output-cap continuation notice.
 * `drop` is only that notice, `hold` is still a prefix of it, `emit` is model text.
 */
export function classifyOutputLimitNotice(raw) {
    const text = noticeText(raw);
    if (text.length === 0)
        return 'emit';
    const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim();
    const retry = text.slice(stripped.length).trim();
    if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry))
        return 'emit';
    if (stripped.length === 0)
        return /^retries remaining:\s*\d+$/i.test(text) ? 'drop' : 'emit';
    const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`;
    if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL)
        return 'drop';
    if (full.startsWith(stripped) && stripped.startsWith('your previous'))
        return 'hold';
    if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith('please continue from where you left off'))
        return 'hold';
    if ('retries remaining:'.startsWith(text) && text.startsWith('retries'))
        return 'hold';
    return 'emit';
}
/** Tool the agent calls to keep waiting on a relayed OMP tool result. */
export const AWAIT_TOOL_NAME = 'omp_await_result';
/** MCP descriptor of {@link AWAIT_TOOL_NAME}. */
export const AWAIT_TOOL = {
    name: AWAIT_TOOL_NAME,
    description: 'Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.',
    inputSchema: {
        type: 'object',
        properties: { call_id: { type: 'string', description: 'The call id from the still-running notice.' } },
        required: ['call_id'],
    },
};
/** Compact MCP descriptor of {@link CALL_TOOL_NAME}. */
export const CALL_TOOL = {
    name: CALL_TOOL_NAME,
    description: 'Invoke a harness tool by exact name when its native mcp_omp_<name> declaration is absent or harness_tool_update supplies a changed parameter schema.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Exact OMP tool name without mcp_omp_ prefix.' },
            arguments: { type: 'object', description: 'Arguments object matching that tool schema.' },
        },
        required: ['name'],
    },
};
/** One running ACP prompt turn. */
export class AcpTurn {
    turnTag;
    events = new AsyncQueue();
    /** Calls handed to OMP whose results have not arrived yet. */
    pendingCalls = new Map();
    /** Calls the agent issued during this turn. */
    calls = new Map();
    /** OMP steps this turn has ended with `tool-calls`. */
    toolSteps = 0;
    /** Long-decode continuations sent in this turn. */
    continuations = 0;
    /** The agent ended the prompt. */
    finished = false;
    /** Latest native prompt completion, independent of buffered stream events. */
    nativePrompt;
    /** A parked call was answered with a still-running notice and the agent has not resumed waiting yet. */
    relaying = false;
    /** The turn produced visible text or a tool call. */
    produced = false;
    /** Agent-side transport retry notices dropped from the output. */
    retryNotices = 0;
    /** Message text that may still be the start of agy's output-cap notice. */
    noticeHold = '';
    /** Model calls inside this turn whose usage was already emitted per-step from SQLite. */
    emittedCalls = 0;
    /** Cumulative raw token counts already emitted per-step from SQLite during this turn. */
    emittedRaw = {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
    };
    nextCall = 0;
    /** @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`). */
    constructor(turnTag) {
        this.turnTag = turnTag;
    }
    /** Track one prompt segment, including long-decode continuations. */
    trackPrompt(promise) {
        const native = { settled: false, completion: Promise.resolve(), error: undefined };
        native.completion = promise.then(() => { native.settled = true; }, error => { native.error = error instanceof Error ? error : new Error(String(error)); native.settled = true; });
        this.nativePrompt = native;
        return promise;
    }
    /**
     * Record one batch of per-step model usage read from the local session DB.
     * @param batch - per-step usage batch consumed since the previous cursor.
     */
    recordStepBatch(batch) {
        this.emittedCalls += batch.calls;
        this.emittedRaw.inputTokens += batch.usage.inputTokens ?? 0;
        this.emittedRaw.outputTokens += batch.usage.outputTokens ?? 0;
        this.emittedRaw.cachedReadTokens += batch.usage.cachedReadTokens ?? 0;
        this.emittedRaw.cachedWriteTokens += batch.usage.cachedWriteTokens ?? 0;
        this.emittedRaw.thoughtTokens += batch.usage.thoughtTokens ?? 0;
    }
    /**
     * Register one agent tool call.
     * @param name - OMP tool name.
     * @param args - parsed arguments.
     * @returns the parked call.
     */
    park(name, args) {
        const call = {
            id: ToolCallId(`agy_${this.turnTag}_${++this.nextCall}`),
            name,
            argumentsJson: JSON.stringify(args),
            result: deferred(),
        };
        this.calls.set(call.id, call);
        this.events.push({ kind: 'park', call });
        return call;
    }
    /**
     * Route one ACP session update into the event queue.
     * @param update - the agent notification.
     */
    onUpdate(update) {
        const text = update.content?.type === 'text' ? update.content.text ?? '' : '';
        if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
            this.consumeMessage(text);
            return;
        }
        if (update.sessionUpdate === 'agent_thought_chunk') {
            const held = this.recoverNoticeHold();
            if (held.length > 0 && !this.relaying)
                this.pushText(held);
            if (text.length > 0 && !this.relaying)
                this.pushThought(text);
        }
    }
    pushText(text) {
        const tail = this.events.peekLast();
        if (tail?.kind === 'text') {
            tail.text += text;
            return;
        }
        this.events.push({ kind: 'text', text });
    }
    pushThought(text) {
        const tail = this.events.peekLast();
        if (tail?.kind === 'thought') {
            tail.text += text;
            return;
        }
        this.events.push({ kind: 'thought', text });
    }
    /**
     * Keep a message chunk out of the chat while it is only agy's output-cap notice.
     * @param text - one streamed message chunk.
     */
    consumeMessage(text) {
        const combined = this.noticeHold + text;
        const notice = combined.trim();
        if (notice === AGENT_EXECUTION_ERROR_NOTICE) {
            this.noticeHold = '';
            this.events.push({ kind: 'error', error: new LlmError('Antigravity: Agent execution terminated due to error.', 'SERVER') });
            return;
        }
        if (notice.length > 0 && AGENT_EXECUTION_ERROR_NOTICE.startsWith(notice)) {
            this.noticeHold = combined;
            return;
        }
        const kind = classifyOutputLimitNotice(combined);
        if (kind === 'hold') {
            this.noticeHold = combined;
            return;
        }
        this.noticeHold = '';
        if (kind === 'drop' || AGENT_RETRY_NOTICE.test(combined)) {
            this.retryNotices++;
            return;
        }
        if (!this.relaying)
            this.pushText(combined);
    }
    /**
     * Release a held prefix once the message stream moves on.
     * A finished output-cap notice is counted and discarded; anything else is returned for emission.
     * @returns model text to show, or an empty string.
     */
    recoverNoticeHold(final = false) {
        if (this.noticeHold.length === 0)
            return '';
        const pending = this.noticeHold.trim();
        if (!final && pending.length > 0 && AGENT_EXECUTION_ERROR_NOTICE.startsWith(pending))
            return '';
        const held = this.noticeHold;
        this.noticeHold = '';
        if (classifyOutputLimitNotice(held) === 'drop') {
            this.retryNotices++;
            return '';
        }
        return this.relaying ? '' : held;
    }
    /**
     * Abandon every parked call with an error result.
     * @param reason - message delivered to the agent.
     */
    abandon(reason) {
        for (const call of this.calls.values()) {
            call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true });
        }
        this.pendingCalls.clear();
    }
}
/**
 * Map one completed prompt or step sample to OMP token usage. When a single
 * sample spanned `calls` internal model steps (tool rounds or continuations),
 * prompt buckets are normalized by `calls` so OMP's native ContextMeter reflects
 * single-request context occupancy rather than the multi-step sum.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`, so every bucket is kept as
 * reported and the total is their sum.
 * @param usage - the agent's step or turn usage.
 * @param calls - model calls executed inside this sample (>= 1).
 * @returns OMP usage.
 */
export function toTokenUsage(usage, calls = 1) {
    if (usage === undefined)
        return undefined;
    const scale = Math.max(1, calls);
    const input = Math.max(0, Math.round((usage.inputTokens ?? 0) / scale));
    const cacheRead = Math.max(0, Math.round((usage.cachedReadTokens ?? 0) / scale));
    const cacheWrite = Math.max(0, Math.round((usage.cachedWriteTokens ?? 0) / scale));
    const output = Math.max(0, usage.outputTokens ?? 0);
    const reasoning = usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
        ? Math.min(output, usage.thoughtTokens)
        : undefined;
    return {
        inputTokens: input,
        outputTokens: output,
        ...usage.cachedReadTokens !== undefined || cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
        ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
        ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
        totalTokens: input + cacheRead + cacheWrite + output,
    };
}
/**
 * Stream one OMP step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - OMP cancellation.
 * @yields OMP stream chunks ending with one finish chunk.
 */
export async function* pumpStep(turn, host, signal) {
    let index = 0;
    let open;
    const close = function* () {
        if (open === undefined)
            return;
        const block = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text };
        yield { type: 'block-end', index: open.index, block };
        open = undefined;
    };
    const append = function* (type, text) {
        if (open?.type !== type) {
            yield* close();
            open = { index: index++, type, text: '' };
            yield { type: 'block-start', index: open.index, blockType: type };
        }
        open.text += text;
        yield type === 'text' ? { type: 'text-delta', index: open.index, text } : { type: 'reasoning-delta', index: open.index, text };
    };
    const abort = function* () {
        host.cancel();
        turn.abandon('The harness cancelled this request.');
        yield* close();
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
    };
    const isAborted = () => signal?.aborted === true;
    for (;;) {
        const ready = await turn.events.wait(signal);
        // A ready queue can outlive cancellation; never hand its calls to OMP.
        if (!ready || isAborted()) {
            yield* abort();
            return;
        }
        if (turn.events.peek()?.kind !== 'text') {
            const head = turn.events.peek()?.kind;
            const held = turn.recoverNoticeHold(head === 'done' || head === 'error' || head === 'park');
            if (held.length > 0) {
                turn.produced = true;
                yield* append('text', held);
            }
        }
        const event = turn.events.shift();
        switch (event.kind) {
            case 'thought':
                yield* append('reasoning', event.text);
                break;
            case 'text':
                turn.produced = true;
                yield* append('text', event.text);
                break;
            case 'park': {
                turn.produced = true;
                yield* close();
                const batch = [event.call];
                // Parallel calls of one model response arrive within a short window.
                while (await turn.events.wait(signal, host.parkSettleMs)) {
                    const next = turn.events.peek();
                    if (next?.kind !== 'park')
                        break;
                    turn.events.shift();
                    batch.push(next.call);
                }
                for (const call of batch) {
                    if (isAborted()) {
                        yield* abort();
                        return;
                    }
                    const blockIndex = index++;
                    turn.pendingCalls.set(call.id, call);
                    yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
                    yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.argumentsJson };
                    yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsJson } };
                }
                const stepSample = await host.consumeStepUsage?.();
                // Cancellation may arrive while blocks are yielded or usage is read.
                if (isAborted()) {
                    yield* abort();
                    return;
                }
                if (stepSample !== undefined) {
                    const usage = toTokenUsage(stepSample.usage, stepSample.calls);
                    if (usage !== undefined)
                        yield { type: 'usage', usage };
                }
                if (isAborted()) {
                    yield* abort();
                    return;
                }
                turn.toolSteps++;
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
                return;
            }
            case 'done': {
                const stop = event.result.stopReason;
                if (stop === 'max_tokens' && turn.continuations < host.maxContinuations) {
                    turn.continuations++;
                    void host.continuePrompt().then(result => turn.events.push({ kind: 'done', result }), (error) => turn.events.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }));
                    break;
                }
                turn.finished = true;
                yield* close();
                const calls = turn.toolSteps + turn.continuations + 1;
                const totalUsage = event.result.usage;
                host.recordUsage(totalUsage, calls);
                const finalSample = await host.consumeStepUsage?.();
                let usage;
                if (finalSample !== undefined) {
                    usage = toTokenUsage(finalSample.usage, finalSample.calls);
                }
                else if (turn.emittedCalls > 0 && totalUsage !== undefined) {
                    const total = totalUsage;
                    const remInput = Math.max(0, (total.inputTokens ?? 0) - turn.emittedRaw.inputTokens);
                    const remOutput = Math.max(0, (total.outputTokens ?? 0) - turn.emittedRaw.outputTokens);
                    const remCacheRead = Math.max(0, (total.cachedReadTokens ?? 0) - turn.emittedRaw.cachedReadTokens);
                    const remCacheWrite = Math.max(0, (total.cachedWriteTokens ?? 0) - turn.emittedRaw.cachedWriteTokens);
                    const remThought = Math.max(0, (total.thoughtTokens ?? 0) - turn.emittedRaw.thoughtTokens);
                    const rem = {
                        inputTokens: remInput,
                        outputTokens: remOutput,
                        ...total.cachedReadTokens !== undefined ? { cachedReadTokens: remCacheRead } : {},
                        cachedWriteTokens: remCacheWrite,
                        thoughtTokens: remThought,
                        totalTokens: remInput + remCacheRead + remCacheWrite + remOutput,
                    };
                    const remCalls = Math.max(1, calls - turn.emittedCalls);
                    usage = toTokenUsage(rem, remCalls);
                }
                else {
                    usage = toTokenUsage(totalUsage, calls);
                }
                if (usage !== undefined)
                    yield { type: 'usage', usage };
                if (stop === 'end_turn' && !turn.produced) {
                    throw new LlmError('Antigravity ended the turn without visible output', 'EMPTY_RESPONSE');
                }
                switch (stop) {
                    case 'end_turn':
                        yield { type: 'finish', reason: { kind: 'stop' } };
                        return;
                    case 'max_tokens':
                        yield { type: 'finish', reason: { kind: 'max-tokens' } };
                        return;
                    case 'cancelled':
                        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Antigravity cancelled the turn', code: 'ABORTED' } } };
                        return;
                    case 'refusal':
                        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Antigravity refused the request', code: 'REFUSAL' } } };
                        return;
                    default:
                        yield { type: 'finish', reason: { kind: 'error', failure: { message: `Antigravity stopped: ${stop}`, code: 'PROVIDER_ERROR' } } };
                        return;
                }
            }
            case 'error':
                turn.finished = true;
                yield* close();
                throw event.error;
        }
    }
}
/**
 * Notice returned to the agent when a OMP tool outlives the MCP call deadline.
 * @param call - the still-running call.
 * @returns MCP result instructing the agent to keep waiting.
 */
export function relayNotice(call) {
    return {
        content: [{
                type: 'text',
                text: `The harness is still running tool call ${call.id} (${call.name}). Call ${AGENT_TOOL_PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
            }],
    };
}
