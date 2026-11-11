/**
 * Process, session, and conversation orchestration for the Antigravity ACP
 * provider. One `agy acp` front serves every conversation; each OMP session
 * (and each auxiliary purpose within it) owns one ACP session whose history
 * advances incrementally, so subagents and the main conversation run
 * concurrently without sharing a turn.
 * @module omp-antigravity-acp/runtime
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as retryDelay } from 'node:timers/promises';
import { LlmError } from "./protocol.js";
import { AcpProcess } from "./acp-process.js";
import { ModelCatalog } from "./catalog.js";
import { asEffort } from "./config.js";
import { AcpTurn, AWAIT_TOOL, AWAIT_TOOL_NAME, CALL_TOOL, CALL_TOOL_NAME, pumpStep, relayNotice } from "./conversation.js";
import { AGENT_TOOL_PREFIX, bridgeSystemPrompt, inputPrompt, LOCKED_REPLAY_BUDGET_BYTES, MCP_SERVER_NAME, renderTranscript, isRuntimeContextSnapshot, replayPrompt, splitSystem, UNLOCKED_REPLAY_BUDGET_BYTES, } from "./history.js";
import { JsonRpcClosedError, JsonRpcRemoteError } from "./jsonrpc.js";
import { McpBridge } from "./mcp-bridge.js";
import { assertSupportedAgyVersion, BRIDGE_AGENT, checkUnlock, defaultHome, defaultPatchScript, GPT_OSS_CONTEXT_WINDOW, LOCKED_CONTEXT_WINDOW, prepareHome, readVersion, resolveAgyBinary, syncOAuthToken, UNLOCKED_CONTEXT_WINDOW, } from "./preflight.js";
import { QuotaReader } from "./quota.js";
import { SessionUsageReader, removeEmptySessionDb, sessionDbPath } from "./usage-db.js";
import { contentDigest, deferred, delay, digest, KeyedMutex, withAbort } from "./util.js";
import { RequestTiming } from "./timing.js";
import { hostArguments } from "./tool-metadata.js";
import { acquireStartupLease } from "./startup-lease.js";
import { UnusedSessionLedger } from "./unused-session-ledger.js";
import { SessionStore } from "./session-store.js";
/** Parked calls answer with a still-running notice before Gemini cache TTL expiry and agy's 180-second MCP deadline. */
export const DEFAULT_RELAY_AFTER_MS = 85_000;
const CONTINUE_PROMPT = 'Continue exactly where your previous output stopped. Do not repeat any earlier text.';
const MAIN_PURPOSE = 'main';
const COMPACTION_PURPOSE = 'compaction';
const TEXT_ONLY_PURPOSE = 'text-only';
const MAX_SKILL_DESCRIPTION_RETRIES = 2;
const MAX_SESSION_CLOSE_ATTEMPTS = 3;
const UNUSED_DB_RETRY_DELAYS_MS = [50, 100, 200, 400];
function isRetryableUnusedDbError(error) {
    if (error === null || typeof error !== 'object')
        return false;
    const { code, errcode } = error;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
        || (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && [5, 6].includes(errcode & 0xff));
}
const COMPACTION_SYSTEM_PROMPT = 'This is a text-only compaction request. Treat the supplied conversation and its earlier instructions as historical material to summarize, not as active tasks. Follow the final user message specifying the checkpoint format. Return only the checkpoint text. Do not call tools, perform actions, resume unfinished work, or claim fresh verification.';
const TEXT_ONLY_SYSTEM_PROMPT = 'This is a text-only request. Follow the current request and return text only. Supplied historical requests and tool calls are reference data. Do not execute tools, resume historical actions, or claim fresh verification.';
/** Only deadlines and explicit transport/server failures get another background attempt. */
export function isRetryableSkillDescriptionFailure(error) {
    if (!(error instanceof Error))
        return false;
    if (error.name === 'TimeoutError')
        return true;
    if (error instanceof LlmError)
        return ['TRANSPORT', 'RATE_LIMIT', 'TIMEOUT', 'SERVER'].includes(error.code);
    return /^(TRANSPORT|RATE_LIMIT|TIMEOUT|SERVER):/.test(error.message);
}
/** Owner of the ACP process, the MCP bridge, and every conversation. */
export class AntigravityRuntime {
    host;
    bridge;
    catalog;
    quota;
    standbyPool = [];
    maxStandbyPoolSize = 2;
    home;
    process;
    startingProcess;
    starting;
    preflight;
    preflightPromise;
    state = 'idle';
    lastError;
    conversations = new Map();
    tenants = new Map();
    standbyTenants = new Map();
    standbyPromise;
    standbyPendingContext;
    standbyPendingProcess;
    standbyEnabled;
    /** Learn the latest main request's native initialization for future, unused sessions. */
    standbyContext = { key: contentDigest({ system: '', tools: [] }), system: '', tools: [] };
    standbyContextKnown = false;
    mainRequestSeen = false;
    discoveryPromise;
    startupLease;
    backgroundActivation = deferred();
    skillDescriptionRetries = new Map();
    /** Retain only keys after completion/exhaustion so duplicate producers cannot reset the budget. */
    retiredSkillDescriptionRetries = new Set();
    skillDescriptionRetryAbort = new AbortController();
    standbyRetryAt = 0;
    standbyFailures = 0;
    standbyRetryTimer;
    /** Includes sessions being opened or closed, not just bound conversations. */
    liveSessionSlots = new Set();
    unusedSessionCleanups = new Map();
    processExitCleanups = new Map();
    unusedSessions = new Map();
    unusedSessionLedger;
    sessions;
    unusedSessionRecovery;
    closeRetryAbort = new AbortController();
    sessionCapacityMutex = new KeyedMutex();
    lastMainModel;
    lastMainEffort;
    lastTokenSyncAt = 0;
    /** Per-turn call-id tags already issued or observed in history; keeps `<rootCallId>:ptc:<n>` unique session-wide. */
    usedTurnTags = new Set();
    mutex = new KeyedMutex();
    /** Serializes capacity checks and session creation so concurrent requests cannot overshoot maxLiveSessions. */
    capacityMutex = new KeyedMutex();
    sweeper;
    lastTurn;
    overrides = {};
    disposed = false;
    /** @param host - host services. */
    constructor(host) {
        this.host = host;
        this.home = host.config.home.length > 0 ? host.config.home : defaultHome();
        this.unusedSessionLedger = new UnusedSessionLedger(this.home, message => host.log.warn(message));
        this.sessions = new SessionStore(join(this.home, 'session-index.json'), message => host.log.warn(message));
        this.standbyEnabled = host.config.warmup;
        this.catalog = new ModelCatalog(join(this.home, 'catalog.json'));
        this.bridge = new McpBridge({
            listTools: tenantKey => this.listTools(tenantKey),
            callTool: request => this.callTool(request),
            authorize: (tenantKey, bearerToken) => this.authorizeTenant(tenantKey, bearerToken),
        }, {
            keepAliveMs: host.config.keepAliveMs,
            log: message => host.log.info(message),
            onResultSent: (tenantKey, name) => {
                const conv = tenantKey === undefined ? undefined : this.tenants.get(tenantKey);
                conv?.timing?.mark('tool_result_sent', { sessionId: conv.sessionId, tool: name });
            },
        });
        this.quota = new QuotaReader(() => this.preflight?.binary ?? resolveAgyBinary(host.config.command), (...args) => host.runCommand(...args), host.config.quotaTtlMs,
            { cachePath: join(this.home, 'quota-cache.json'), warn: message => host.log.warn(message) });
        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref?.();
    }
    /** Only completed, clean main conversations can be resumed after a restart. */
    persistConversation(conv) {
        if (conv.purpose !== MAIN_PURPOSE || conv.key.startsWith('anon-') || conv.turn !== undefined
            || conv.dirty || conv.sessionId === undefined || conv.knownHistory === undefined || conv.systemHash === undefined)
            return;
        this.sessions.save(conv.key, {
            sessionId: conv.sessionId,
            workspace: this.preflight?.workspace ?? this.home,
            numericEnumMode: this.host.config.numericEnumMode,
            systemHash: conv.systemHash,
            knownHistory: structuredClone(conv.knownHistory),
            emittedAssistant: conv.emittedAssistant,
            advertisedTools: structuredClone(conv.advertisedTools),
            nativeToolBaselines: structuredClone(conv.nativeToolBaselines),
            knownTools: structuredClone([...conv.knownTools]),
            issuedIds: [...conv.issuedIds],
        });
    }
    async tryResumeSession(conv, system, tools, history, proc, signal) {
        if (conv.sessionId !== undefined || conv.dirty || conv.purpose !== MAIN_PURPOSE || conv.key.startsWith('anon-'))
            return false;
        const entry = this.sessions.get(conv.key);
        if (entry === undefined)
            return false;
        const candidate = { ...conv, systemHash: entry.systemHash, knownHistory: entry.knownHistory, emittedAssistant: entry.emittedAssistant };
        if (entry.workspace !== (this.preflight?.workspace ?? this.home)
            || entry.numericEnumMode !== this.host.config.numericEnumMode || !this.historyPrefixIntact(candidate, system, history)) {
            this.sessions.forget(conv.key);
            return false;
        }
        if (proc.initializeResult?.agentCapabilities?.loadSession !== true)
            return false;
        try {
            await this.openSession(conv, system, tools, proc, signal, entry);
            conv.systemHash = entry.systemHash;
            conv.knownHistory = structuredClone(entry.knownHistory);
            conv.emittedAssistant = entry.emittedAssistant;
            conv.issuedIds = new Set(entry.issuedIds);
            return true;
        }
        catch (error) {
            signal?.throwIfAborted();
            this.sessions.forget(conv.key);
            this.host.log.warn(`antigravity-acp: session/load failed (${entry.sessionId}); rebuilding from PI history: ${String(error)}`);
            return false;
        }
    }
    /** Configured context window (0 = auto). */
    configuredContextWindow() {
        return this.overrides.contextWindow ?? this.host.config.contextWindow;
    }
    /**
     * Declared context window of every family.
     * @returns tokens.
     */
    contextWindow() {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        return this.preflight?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
    }
    /**
     * Declared context window of one family. Claude 5.5 shares the 1M pool when
     * the binary is unlocked; GPT-OSS 120B keeps its own 128K-class window.
     * @param model - family id.
     * @returns tokens.
     */
    contextWindowFor(model) {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        if (model.startsWith('gpt-oss'))
            return GPT_OSS_CONTEXT_WINDOW;
        return this.preflight?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
    }
    /**
     * Validate the requested effort without substituting another level. The
     * live session selector is checked again before generation can resume.
     * @param model - family id.
     * @param requested - effort the caller asked for.
     * @returns the effort to apply.
     */
    effectiveEffort(model, requested) {
        if (asEffort(requested) === undefined)
            throw new LlmError(`Unsupported reasoning effort ${String(requested)}; choose low, medium, or high`, 'EFFORT_UNAVAILABLE');
        const fixed = this.catalog.fixedEffort(model);
        if (fixed !== undefined && fixed !== requested)
            throw new LlmError(`Model ${model} has fixed effort ${fixed}; requested effort ${requested} cannot be applied`, 'EFFORT_UNAVAILABLE');
        return requested;
    }
    /** Default effort. */
    defaultEffort() {
        return this.overrides.defaultEffort ?? this.host.config.defaultEffort;
    }
    /** Maximum automatic long-decode continuations. */
    longDecodeContinuations() {
        return this.overrides.longDecodeContinuations ?? this.host.config.longDecodeContinuations;
    }
    /**
     * Apply live runtime settings immediately and notify catalog observers.
     * @param patch - updated fields.
     * @returns updated status.
     */
    configure(patch) {
        this.overrides = { ...this.overrides, ...patch };
        this.host.onModelsChanged?.();
        return this.status();
    }
    /**
     * Current status for diagnostics surfaces.
     * @returns the status snapshot.
     */
    status() {
        return {
            state: this.state,
            ...this.lastError !== undefined ? { error: this.lastError } : {},
            ...this.preflight !== undefined ? {
                binary: this.preflight.binary,
                version: this.preflight.version,
                home: this.preflight.home,
                unlock: this.preflight.unlock,
            } : {},
            contextWindow: this.contextWindow(),
            configuredContextWindow: this.configuredContextWindow(),
            defaultEffort: this.defaultEffort(),
            longDecodeContinuations: this.longDecodeContinuations(),
            models: this.catalog.list().map(m => ({ ...m })),
            efforts: [...this.catalog.effortList()],
            liveSessions: this.liveSessionSlots.size,
            activeTurns: [...this.conversations.values()].filter(c => c.turn !== undefined && !c.turn.finished).length,
            ...this.lastTurn !== undefined ? { lastTurn: this.lastTurn } : {},
        };
    }
    /**
     * Run preflight and start the ACP process.
     * @returns the running process.
     */
    async ensureReady(activateSkillRetries = true) {
        if (this.disposed)
            throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
        const proc = this.process?.alive === true ? this.process
            : await (this.starting ??= this.start().finally(() => { this.starting = undefined; }));
        if (this.disposed || !proc.alive)
            throw new LlmError('Antigravity ACP is no longer ready', 'TRANSPORT');
        if (activateSkillRetries) {
            this.backgroundActivation.resolve(undefined);
            this.resumeSkillDescriptionRetries();
        }
        return proc;
    }
    claimStartupLease() {
        if (this.startupLease !== undefined)
            return true;
        try {
            this.startupLease = acquireStartupLease(this.home);
        }
        catch (error) {
            this.host.log.warn(`antigravity-acp: speculative startup deferred: ${String(error)}`);
        }
        return this.startupLease !== undefined;
    }
    /** Only host skill compression waits; normal model calls activate their own runtime. */
    async waitForSkillDescription(signal, onDeferred) {
        signal?.throwIfAborted();
        if (this.disposed)
            throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
        if (this.process?.alive === true || this.backgroundActivation.settled || this.claimStartupLease())
            return;
        this.host.log.info('antigravity-acp: skill description compression deferred until runtime activation');
        onDeferred?.();
        await withAbort(this.backgroundActivation.promise, signal);
        signal?.throwIfAborted();
        if (this.disposed)
            throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
    }
    /** Register the original host failure once; later activations may resume a transient failure. */
    queueSkillDescriptionRetry(key, retry) {
        if (this.disposed || this.skillDescriptionRetries.has(key) || this.retiredSkillDescriptionRetries.has(key))
            return;
        const entry = { retry, attempts: 0, inFlight: false };
        this.skillDescriptionRetries.set(key, entry);
        this.host.log.info('antigravity-acp: skill description retry queued for runtime activation');
        void this.backgroundActivation.promise.then(() => {
            // The initial activation callback must not spend a second attempt when
            // an earlier ensureReady continuation already ran this entry.
            if (entry.attempts === 0)
                this.startSkillDescriptionRetry(key, entry);
        }, () => { this.skillDescriptionRetries.delete(key); });
    }
    resumeSkillDescriptionRetries() {
        for (const [key, entry] of this.skillDescriptionRetries)
            this.startSkillDescriptionRetry(key, entry);
    }
    startSkillDescriptionRetry(key, entry) {
        if (this.disposed || this.process?.alive !== true || entry.inFlight
            || this.skillDescriptionRetries.get(key) !== entry)
            return;
        entry.inFlight = true;
        entry.attempts++;
        const attempt = entry.attempts;
        this.host.log.info(`antigravity-acp: skill description retry started (${attempt}/${MAX_SKILL_DESCRIPTION_RETRIES})`);
        void (async () => {
            let retire = true;
            try {
                await entry.retry(AbortSignal.any([this.skillDescriptionRetryAbort.signal, AbortSignal.timeout(30_000)]));
                this.host.log.info('antigravity-acp: skill description retry finished');
            }
            catch (error) {
                if (!this.disposed) {
                    retire = attempt >= MAX_SKILL_DESCRIPTION_RETRIES || !isRetryableSkillDescriptionFailure(error);
                    const next = retire ? 'retired' : 'waiting for a later activation';
                    this.host.log.warn(`antigravity-acp: skill description retry failed (${attempt}/${MAX_SKILL_DESCRIPTION_RETRIES}; ${next}): ${String(error)}`);
                }
            }
            finally {
                entry.inFlight = false;
                if (retire && this.skillDescriptionRetries.get(key) === entry) {
                    this.skillDescriptionRetries.delete(key);
                    if (!this.disposed)
                        this.retiredSkillDescriptionRetries.add(key);
                }
            }
        })();
    }
    /**
     * Warm the process, refresh the catalog, and pre-warm a standby ACP session.
     * @returns resolves when discovery and standby warmup finished.
     */
    async warmup(context) {
        if (this.disposed)
            throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
        if (this.process?.alive !== true && !this.claimStartupLease())
            return;
        // A late startup hook must not replace a real request's authoritative template.
        if (context !== undefined && !this.mainRequestSeen) {
            const tools = toBridgeTools(context.tools);
            this.standbyContext = { key: contentDigest({ system: context.system, tools }), system: context.system, tools };
            this.standbyContextKnown = true;
            this.lastMainModel = context.model;
            this.lastMainEffort = asEffort(context.reasoningEffort) ?? this.defaultEffort();
        }
        this.standbyEnabled = true;
        const proc = await this.ensureReady(false);
        if (this.standbyContextKnown) {
            await this.discoveryPromise;
            for (const entry of [...this.standbyPool]) {
                if (entry.contextKey !== this.standbyContext.key)
                    this.closeStandbyInBackground(entry);
            }
            await this.warmStandbySession(proc);
            return;
        }
        // Catalog-only callers have no template to prewarm. Coalesce discovery and
        // close its temporary worker instead of pooling an empty native context.
        this.discoveryPromise ??= (async () => {
            const result = await this.newTrackedSession(proc, {
                cwd: this.preflight?.workspace ?? this.home,
                mcpServers: [],
            }, { onUpdate: () => undefined }, true);
            if (result === undefined)
                return;
            if (this.catalog.observe(result.configOptions, result.models?.availableModels))
                this.host.onModelsChanged?.();
            await this.closeUnusedSession(proc, result.sessionId);
        })();
        const discovery = this.discoveryPromise;
        try {
            await discovery;
        }
        catch (error) {
            if (this.discoveryPromise === discovery)
                this.discoveryPromise = undefined;
            throw error;
        }
    }
    /** Stop every session, the process, and the bridge. */
    async dispose() {
        this.disposed = true;
        this.quota.dispose();
        this.closeRetryAbort.abort(new Error('Antigravity provider was disposed'));
        this.skillDescriptionRetryAbort.abort(new Error('Antigravity provider was disposed'));
        this.skillDescriptionRetries.clear();
        this.retiredSkillDescriptionRetries.clear();
        this.backgroundActivation.reject(new LlmError('Antigravity provider was disposed', 'TRANSPORT'));
        this.state = 'idle';
        this.standbyEnabled = false;
        if (this.standbyRetryTimer !== undefined)
            clearTimeout(this.standbyRetryTimer);
        this.standbyRetryTimer = undefined;
        if (this.sweeper !== undefined)
            clearInterval(this.sweeper);
        for (const conv of this.conversations.values()) {
            if (!conv.opening && conv.turn === undefined)
                this.persistConversation(conv);
            else
                this.sessions.forget(conv.key);
            conv.turn?.abandon('The harness provider was unloaded.');
        }
        this.conversations.clear();
        this.tenants.clear();
        this.standbyTenants.clear();
        // Link failure may already have detached a still-running native process.
        const processes = new Set([
            ...[this.process, this.startingProcess].flatMap(proc => proc === undefined ? [] : [proc]),
            ...this.processExitCleanups.keys(),
            ...this.unusedSessions.values(),
            ...[...this.liveSessionSlots].map(slot => slot.process),
        ]);
        for (const proc of processes)
            proc.stop();
        // Background retirement removes entries before their DB handles are released.
        // Finish already-started cleanup without cancelling its bounded retry delay.
        await this.unusedSessionRecovery;
        try {
            await withAbort(Promise.all([...this.processExitCleanups.values()]), AbortSignal.timeout(15_000));
        }
        catch (error) {
            this.host.log.warn(`antigravity-acp: native exit cleanup did not finish during shutdown; ownership records retained: ${String(error)}`);
        }
        const cleanups = await Promise.allSettled([...this.unusedSessionCleanups.values()]);
        for (const cleanup of cleanups) {
            if (cleanup.status === 'rejected')
                this.host.log.warn(`antigravity-acp: unused session cleanup failed during shutdown: ${String(cleanup.reason)}`);
        }
        this.standbyContext = { key: contentDigest({ system: '', tools: [] }), system: '', tools: [] };
        this.standbyContextKnown = false;
        this.mainRequestSeen = false;
        this.discoveryPromise = undefined;
        this.process = undefined;
        await this.bridge.close();
        try {
            this.startupLease?.release();
        }
        catch (error) {
            this.host.log.warn(`antigravity-acp: startup lease release failed: ${String(error)}`);
        }
        this.startupLease = undefined;
    }
    /**
     * Stream one OMP model step.
     * @param options - the model request.
     * @yields stream chunks.
     */
    async *stream(options) {
        const timing = this.host.config.traceTimings ? new RequestTiming(message => this.host.log.info(message)) : undefined;
        const isAborted = () => options.signal?.aborted === true;
        if (isAborted()) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
            return;
        }
        let release;
        let conv;
        try {
            const proc = await withAbort(this.ensureReady(options.skillDescription !== true), options.signal);
            options.signal?.throwIfAborted();
            timing?.mark('process_ready');
            // Purposes are declared by producer packages this plugin does not import.
            const declaredPurpose = options.purpose;
            const purpose = declaredPurpose !== undefined && declaredPurpose.length > 0 ? declaredPurpose : MAIN_PURPOSE;
            const scope = options.sessionId ?? `anon-${randomBytes(6).toString('hex')}`;
            const key = `${scope}|${purpose}`;
            release = await this.mutex.acquire(key, options.signal);
            options.signal?.throwIfAborted();
            const split = splitSystem(options);
            const history = snapshotHistory(split.messages);
            // OMP retains tool schemas on compaction calls for provider prefix reuse.
            // The summarizer cannot execute tool calls: do not expose MCP or tool deltas.
            const tools = purpose === COMPACTION_PURPOSE || purpose === TEXT_ONLY_PURPOSE ? [] : toBridgeTools(options.tools);
            const effort = this.effectiveEffort(options.model, options.reasoningEffort ?? this.defaultEffort());
            conv = await this.acquireConversation(key, purpose, {
                system: split.system,
                tools,
                model: options.model,
                effort,
            }, options.signal);
            options.signal?.throwIfAborted();
            conv.timing = timing;
            timing?.mark('conversation_acquired');
            conv.lastUsed = Date.now();
            conv.toolNames = new Set(tools.map(t => t.name));
            conv.numericEnumRules.clear();
            if (this.host.config.numericEnumMode !== 'dispatch') {
                for (const tool of tools) {
                    if (!toolState(tool).hasNonStringEnum)
                        continue;
                    const lowered = lowerNumericEnums(tool);
                    if (lowered !== undefined)
                        conv.numericEnumRules.set(tool.name, lowered.rules);
                }
            }
            if (conv.turn !== undefined && conv.turn.pendingCalls.size > 0) {
                // Resuming a parked turn is only valid while the request still starts
                // with the exact history this ACP session already owns. A compaction
                // checkpoint or a pruned/rewritten prefix means the live server-side
                // context is stale: resolving the parked calls would grow it further
                // instead of adopting the compacted history, so abandon the turn and
                // let plan() rebuild the session from OMP's authoritative messages.
                if (!this.historyPrefixIntact(conv, split.system, history)) {
                    this.dropTurn(conv, 'The conversation history was compacted or rewritten; rebuilding the session from the harness history.');
                }
                else if (this.isTurnLive(conv.turn) && (conv.model !== options.model || conv.effort !== effort)) {
                    // agy snapshots the executor configuration at session/prompt.
                    // A config ACK while MCP is parked only changes future prompts;
                    // releasing this result would continue with the previous effort.
                    this.host.log.info(`antigravity-acp: restarting executor ${JSON.stringify({ sessionId: conv.sessionId,
                        previousModel: conv.model, previousEffort: conv.effort, model: options.model, requestedEffort: effort })}`);
                    this.dropTurn(conv, 'The requested model or reasoning effort changed; rebuilding with the completed tool results.');
                }
                else {
                    timing?.mark('session_ready', { sessionId: conv.sessionId, reused: true });
                    const resumed = await this.deliverResults(conv, split.messages, proc, tools, options.signal, options.model, effort);
                    if (resumed) {
                        conv.knownHistory = history;
                        yield* this.pump(conv, proc, options, effort);
                        return;
                    }
                    this.dropTurn(conv, 'The conversation history changed; the harness restarted this turn.');
                }
            }
            else if (conv.turn !== undefined) {
                this.dropTurn(conv, 'Superseded by a newer request.');
            }
            const resumedFromDisk = await this.tryResumeSession(conv, split.system, tools, history, proc, options.signal);
            const plan = this.plan(conv, split.system, split.messages, history);
            if (resumedFromDisk && !plan.rebuild)
                this.host.log.info(`antigravity-acp: restored session ${conv.sessionId}`);
            const replayBudget = this.preflight?.unlock.status === 'unlocked'
                ? UNLOCKED_REPLAY_BUDGET_BYTES
                : LOCKED_REPLAY_BUDGET_BYTES;
            // Image preparation is independent of ACP setup. Settle both branches
            // before releasing the conversation lock, including when either fails.
            const conversation = conv;
            const [setup, prepared] = await Promise.allSettled([
                (async () => {
                    if (plan.rebuild && (conversation.knownHistory !== undefined || conversation.dirty)) {
                        await withAbort(this.resetSession(conversation), options.signal);
                    }
                    const reused = conversation.sessionId !== undefined;
                    if (!reused) {
                        conversation.systemHash = digest(split.system);
                        await this.openSession(conversation, split.system, tools, proc, options.signal);
                    }
                    options.signal?.throwIfAborted();
                    timing?.mark('session_ready', { sessionId: conversation.sessionId, reused });
                    const switched = await this.select(conversation, proc, options.model, effort, { confirm: true, phase: 'prompt' });
                    const settleMs = this.host.config.coldSwitchSettleMs ?? 80;
                    if ((!reused || resumedFromDisk) && switched && settleMs > 0)
                        await retryDelay(settleMs, undefined, { signal: options.signal });
                    timing?.mark('model_configured', { sessionId: conversation.sessionId });
                })(),
                plan.rebuild
                    ? replayPrompt(plan.history, plan.input, this.host.readImage, replayBudget)
                    : inputPrompt(plan.input, this.host.readImage),
            ]);
            if (setup.status === 'rejected')
                throw setup.reason;
            if (prepared.status === 'rejected')
                throw prepared.reason;
            options.signal?.throwIfAborted();
            const blocks = prepared.value;
            const toolDelta = consumeToolDelta(conv, tools);
            if (toolDelta.length > 0)
                blocks.unshift({ type: 'text', text: `${toolDelta}\n\n` });
            conv.knownHistory = history;
            // A new turn starts with an empty reported-identity space: ids from past
            // turns must never back a fresh permission request.
            conv.reportedToolCalls.clear();
            conv.turn = new AcpTurn(this.nextTurnTag(split.messages));
            this.startPrompt(conv, proc, blocks);
            yield* this.pump(conv, proc, options, effort);
        }
        catch (error) {
            if (conv?.sessionId !== undefined && conv.process !== undefined
                && this.unusedSessions.get(conv.sessionId) === conv.process) {
                this.dropTurn(conv, 'The request ended before its first native prompt.');
                const cleanup = this.resetSession(conv);
                if (isAborted()) {
                    void cleanup.catch(error => this.host.log.warn(`antigravity-acp: cancelled unused session cleanup failed: ${String(error)}`));
                }
                else {
                    await cleanup;
                }
            }
            if (!isAborted())
                throw error;
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
        }
        finally {
            release?.();
            if (conv !== undefined) {
                conv.opening = false;
                await this.afterStep(conv);
            }
        }
    }
    /**
     * Acquire one conversation under the capacity gate. A never-prompted standby
     * is adopted only when its native context matches. Other requests initialize
     * their system and tool declarations through the cold session path. At
     * capacity, the oldest idle (non-opening) conversation is retired first.
     */
    async acquireConversation(key, purpose, init, signal) {
        signal?.throwIfAborted();
        if (purpose === MAIN_PURPOSE && init !== undefined) {
            this.mainRequestSeen = true;
            this.standbyContextKnown = true;
            const key = contentDigest({ system: init.system, tools: init.tools });
            if (key !== this.standbyContext.key) {
                this.standbyContext = { key, system: init.system, tools: init.tools };
            }
            this.lastMainModel = init.model;
            this.lastMainEffort = init.effort;
        }
        const existing = this.conversations.get(key);
        if (existing !== undefined) {
            existing.opening = true;
            return existing;
        }
        const unlock = await this.capacityMutex.acquire('capacity', signal);
        let conv;
        try {
            signal?.throwIfAborted();
            const again = this.conversations.get(key);
            if (again !== undefined) {
                again.opening = true;
                return again;
            }
            const max = Math.max(1, this.host.config.maxLiveSessions);
            if (this.conversations.size >= max) {
                const idle = [...this.conversations.values()]
                    .filter(c => c.turn === undefined && !c.opening)
                    .sort((a, b) => a.lastUsed - b.lastUsed);
                while (this.conversations.size >= max && idle.length > 0) {
                    const victim = idle.shift();
                    this.conversations.delete(victim.key);
                    await withAbort(this.recycleSession(victim), signal);
                }
            }
            if (this.conversations.size >= max) {
                throw new LlmError(`CAPACITY_EXCEEDED: maxLiveSessions (${max}) reached`, 'RATE_LIMIT');
            }
            signal?.throwIfAborted();
            conv = this.createConversation(key, purpose);
            conv.opening = true;
        }
        finally {
            unlock();
        }
        return conv;
    }
    createConversation(key, purpose) {
        const conv = {
            timing: undefined,
            key,
            purpose,
            standbySlot: undefined,
            tenantKey: undefined,
            tenantSecret: undefined,
            sessionId: undefined,
            process: undefined,
            configOptions: [],
            selecting: false,
            configurationError: undefined,
            systemHash: undefined,
            advertisedTools: [],
            nativeToolBaselines: [],
            numericEnumRules: new Map(),
            advertisedToolNames: new Set(),
            knownTools: new Map(),
            toolNames: new Set(),
            reportedToolCalls: new Map(),
            opening: false,
            usageReader: undefined,
            knownHistory: undefined,
            emittedAssistant: undefined,
            issuedIds: new Set(),
            turn: undefined,
            dirty: false,
            lastUsed: Date.now(),
            model: undefined,
            effort: undefined,
        };
        this.conversations.set(key, conv);
        return conv;
    }
    async start() {
        this.state = 'starting';
        let proc;
        try {
            const preflight = await this.prepare();
            if (this.disposed)
                throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
            this.unusedSessionRecovery ??= this.recoverUnusedSessions().catch(error => {
                this.host.log.warn(`antigravity-acp: unused session startup recovery failed: ${String(error)}`);
            });
            await this.bridge.start();
            if (this.disposed)
                throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
            const argv = [
                preflight.binary, 'acp',
                '--gemini-dir', preflight.home,
                '--app-data-dir', 'agy',
                '--agent', BRIDGE_AGENT,
                '--process-per-session',
                '--disable-telemetry',
                '--log-file', preflight.logFile,
            ];
            proc = new AcpProcess({
                argv,
                cwd: preflight.workspace,
                spawn: this.host.spawnAcp,
                // The ACP server only advertises Claude and GPT-OSS to clients on its
                // JetBrains/Zed/Xcode allowlist; this prefix is what unlocks them.
                clientName: 'jetbrains.omp',
                clientVersion: '1.1.8',
                log: message => this.host.log.warn(message),
            });
            const startingProcess = proc;
            this.startingProcess = proc;
            proc.onExit(error => this.onProcessExit(startingProcess, error));
            await proc.start(120_000);
            if (this.disposed)
                throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
            this.process = proc;
            this.state = 'ready';
            this.lastError = undefined;
            return proc;
        }
        catch (error) {
            proc?.stop();
            await this.bridge.close();
            if (!this.disposed) {
                this.state = 'error';
                this.lastError = error instanceof Error ? error.message : String(error);
            }
            throw mapError(error);
        }
        finally {
            if (this.startingProcess === proc)
                this.startingProcess = undefined;
        }
    }
    /** Inspect the local CLI and context gates without starting ACP. */
    prepare() {
        if (this.disposed)
            return Promise.reject(new LlmError('Antigravity provider was disposed', 'TRANSPORT'));
        if (this.preflight !== undefined)
            return Promise.resolve(this.preflight);
        this.preflightPromise ??= (async () => {
            const config = this.host.config;
            const binary = resolveAgyBinary(config.command);
            const version = await readVersion(binary, this.host.runCommand);
            assertSupportedAgyVersion(version, binary);
            const script = config.patchScript.length > 0 ? config.patchScript : defaultPatchScript();
            const unlock = await checkUnlock(binary, script, config.autoPatch, this.host.runCommand);
            this.host.log.info(`antigravity-acp: ${unlock.detail}`);
            const workspace = prepareHome(this.home);
            const result = { binary, version, home: this.home, workspace,
                logFile: join(this.home, `acp.front.${process.pid}.${randomBytes(6).toString('hex')}.log`), unlock };
            this.preflight = result;
            this.host.onModelsChanged?.();
            return result;
        })().finally(() => { this.preflightPromise = undefined; });
        return this.preflightPromise;
    }
    onProcessExit(proc, error) {
        // A closed JSON-RPC link may still have a live native worker. Wait for the
        // host's actual exit confirmation before reclaiming capacity or unused DBs.
        if (proc.exited !== undefined && !this.processExitCleanups.has(proc)) {
            const cleanup = proc.exited.then(async () => {
                for (const slot of this.liveSessionSlots) {
                    if (slot.process === proc)
                        this.liveSessionSlots.delete(slot);
                }
                for (const [sessionId, owner] of [...this.unusedSessions]) {
                    if (owner === proc)
                        await this.closeUnusedSession(proc, sessionId);
                }
            }).catch(error => this.host.log.warn(`antigravity-acp: unused session exit recovery failed: ${String(error)}`));
            this.processExitCleanups.set(proc, cleanup);
            void cleanup.finally(() => { this.processExitCleanups.delete(proc); });
        }
        if (this.process === proc) {
            this.process = undefined;
            this.discoveryPromise = undefined;
            if (this.standbyRetryTimer !== undefined)
                clearTimeout(this.standbyRetryTimer);
            this.standbyRetryTimer = undefined;
            this.standbyRetryAt = 0;
            this.standbyFailures = 0;
        }
        for (let i = this.standbyPool.length - 1; i >= 0; i--) {
            const standby = this.standbyPool[i];
            if (standby.process === proc) {
                this.standbyTenants.delete(standby.tenantKey);
                this.bridge.forgetTenant(standby.tenantKey);
                this.standbyPool.splice(i, 1);
            }
        }
        if (!this.disposed) {
            this.state = 'error';
            this.lastError = error.message;
            this.host.log.warn(`antigravity-acp: ${error.message}`);
        }
        for (const conv of this.conversations.values()) {
            if (conv.process !== proc)
                continue;
            if (conv.turn === undefined && !conv.opening)
                this.persistConversation(conv);
            else
                this.sessions.forget(conv.key);
            conv.turn?.events.push({ kind: 'error', error: new LlmError(`Antigravity ACP process exited: ${error.message}`, 'TRANSPORT') });
            this.releaseTenant(conv);
            conv.standbySlot = undefined;
            conv.sessionId = undefined;
            conv.process = undefined;
            conv.tenantKey = undefined;
            conv.tenantSecret = undefined;
            conv.advertisedTools = [];
            conv.nativeToolBaselines = [];
            conv.advertisedToolNames.clear();
            conv.knownTools.clear();
            conv.reportedToolCalls.clear();
            conv.usageReader = undefined;
            conv.dirty = true;
        }
    }
    syncOAuthTokenIfNeeded() {
        const now = Date.now();
        if (now - this.lastTokenSyncAt < 5_000)
            return;
        this.lastTokenSyncAt = now;
        syncOAuthToken(this.home);
    }
    /** Reserve capacity before starting ACP work, including background warmup. */
    async newTrackedSession(proc, params, listener, background = false, signal, loadSessionId) {
        const max = Math.max(1, this.host.config.maxLiveSessions);
        if (!background && this.liveSessionSlots.size >= max && this.standbyPromise !== undefined) {
            await withAbort(this.standbyPromise, signal);
        }
        const unlock = await this.sessionCapacityMutex.acquire('sessions', signal);
        const slot = { process: proc, ...(loadSessionId !== undefined ? { sessionId: loadSessionId } : {}) };
        try {
            signal?.throwIfAborted();
            if (this.disposed || !proc.alive)
                throw new LlmError('Antigravity ACP process is unavailable', 'TRANSPORT');
            if (!background) {
                if (this.liveSessionSlots.size >= max) {
                    const retiring = new Set([...this.liveSessionSlots].flatMap(s => s.closing === undefined ? [] : [s.closing]));
                    // Recheck capacity after each acknowledgement; unrelated slow closes
                    // must not hold a foreground request once one native slot is free.
                    while (this.liveSessionSlots.size >= max && retiring.size > 0) {
                        await withAbort(Promise.race([...retiring].map(closing => closing.then(() => { retiring.delete(closing); }))), signal);
                    }
                }
                while (this.liveSessionSlots.size >= max && this.standbyPool.length > 0) {
                    await withAbort(this.discardStandby(this.standbyPool[0]), signal);
                }
                while (this.liveSessionSlots.size >= max) {
                    const victim = [...this.conversations.values()]
                        .filter(c => c.sessionId !== undefined && this.isIdle(c))
                        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
                    if (victim === undefined)
                        break;
                    this.conversations.delete(victim.key);
                    await withAbort(this.resetSession(victim, true), signal);
                }
            }
            if (this.disposed || !proc.alive)
                throw new LlmError('Antigravity ACP process is unavailable', 'TRANSPORT');
            if (this.liveSessionSlots.size >= max) {
                if (background)
                    return undefined;
                throw new LlmError(`CAPACITY_EXCEEDED: maxLiveSessions (${max}) reached`, 'RATE_LIMIT');
            }
            signal?.throwIfAborted();
            this.liveSessionSlots.add(slot);
        }
        finally {
            unlock();
        }
        try {
            const result = loadSessionId !== undefined
                ? await proc.loadSession({ ...params, sessionId: loadSessionId }, listener, 120_000)
                : await proc.newSession(params, listener, 120_000);
            slot.sessionId = result.sessionId;
            if (loadSessionId !== undefined)
                return result;
            this.unusedSessions.set(result.sessionId, proc);
            try {
                if (proc.pid === undefined)
                    throw new Error('Native ACP pid is unavailable; persistent recovery is disabled for this session');
                this.unusedSessionLedger.track(result.sessionId, proc.pid);
            }
            catch (error) {
                this.host.log.warn(`antigravity-acp: unused session ownership could not be recorded (${result.sessionId}): ${String(error)}`);
            }
            return result;
        }
        catch (error) {
            if (loadSessionId !== undefined && proc.alive)
                await this.closeTrackedSession(proc, loadSessionId);
            else if (proc.alive || proc.hasExited)
                this.liveSessionSlots.delete(slot);
            throw error;
        }
    }
    /** Release capacity only after ACP acknowledges closure or its process exits. */
    async closeTrackedSession(proc, sessionId) {
        const slot = [...this.liveSessionSlots].find(s => s.process === proc && s.sessionId === sessionId);
        if (slot?.closing !== undefined)
            return slot.closing;
        if (slot === undefined)
            return proc.closeSession(sessionId);
        if (proc.hasExited) {
            this.liveSessionSlots.delete(slot);
            return true;
        }
        // The budget belongs to the native slot, including repeated callers.
        if ((slot.closeAttempts ?? 0) >= MAX_SESSION_CLOSE_ATTEMPTS)
            return false;
        const exited = new AbortController();
        const unsubscribe = proc.onExit(() => exited.abort());
        const signal = AbortSignal.any([exited.signal, this.closeRetryAbort.signal]);
        const closing = (async () => {
            try {
                while ((slot.closeAttempts ?? 0) < MAX_SESSION_CLOSE_ATTEMPTS) {
                    slot.closeAttempts = (slot.closeAttempts ?? 0) + 1;
                    if (await proc.closeSession(sessionId) || proc.hasExited) {
                        this.liveSessionSlots.delete(slot);
                        return true;
                    }
                    if (signal.aborted || this.disposed)
                        return false;
                    if (slot.closeAttempts >= MAX_SESSION_CLOSE_ATTEMPTS) {
                        this.host.log.warn(`antigravity-acp: session close exhausted ${MAX_SESSION_CLOSE_ATTEMPTS} attempts for ${sessionId}; retaining capacity until process exit`);
                        return false;
                    }
                    const waitMs = 500 * 2 ** (slot.closeAttempts - 1);
                    this.host.log.warn(`antigravity-acp: session close attempt ${slot.closeAttempts}/${MAX_SESSION_CLOSE_ATTEMPTS} failed for ${sessionId}; retrying in ${waitMs}ms`);
                    try {
                        await retryDelay(waitMs, undefined, { signal });
                    }
                    catch (error) {
                        if (signal.aborted)
                            return proc.hasExited;
                        throw error;
                    }
                }
                return false;
            }
            finally {
                unsubscribe();
                if (proc.hasExited)
                    this.liveSessionSlots.delete(slot);
                delete slot.closing;
            }
        })();
        slot.closing = closing;
        return closing;
    }
    async closeUnusedSession(proc, sessionId) {
        await this.cleanupUnusedSession(sessionId, () => this.closeTrackedSession(proc, sessionId));
    }
    async recoverUnusedSessions() {
        for (const record of this.unusedSessionLedger.recoverable()) {
            await this.cleanupUnusedSession(record.sessionId, undefined, record.owner);
        }
    }
    async cleanupUnusedSession(sessionId, close, recordOwner) {
        const existing = this.unusedSessionCleanups.get(sessionId);
        if (existing !== undefined)
            return existing;
        const cleanup = (async () => {
            if (close !== undefined && !await close())
                return;
            const dbCleanup = { mainRemoved: false };
            for (let attempt = 0;; attempt++) {
                try {
                    const present = this.unusedSessionLedger.ownedBy(sessionId, recordOwner);
                    if (!present) {
                        this.unusedSessions.delete(sessionId);
                        return;
                    }
                    // Reopen and recheck steps on every attempt; never reuse an earlier
                    // emptiness result after waiting for a Windows/SQLite file lock.
                    removeEmptySessionDb(this.home, sessionId, dbCleanup);
                    try {
                        this.unusedSessionLedger.forget(sessionId, recordOwner);
                    }
                    catch (error) {
                        this.host.log.warn(`antigravity-acp: unused session ownership record retained (${sessionId}): ${String(error)}`);
                        return;
                    }
                    this.unusedSessions.delete(sessionId);
                    return;
                }
                catch (error) {
                    const waitMs = UNUSED_DB_RETRY_DELAYS_MS[attempt];
                    if (waitMs === undefined || !isRetryableUnusedDbError(error)) {
                        this.host.log.warn(`antigravity-acp: unused session DB retained (${sessionId}; ${attempt + 1} attempts): ${String(error)}`);
                        return;
                    }
                    this.host.log.info(`antigravity-acp: unused session DB cleanup retry (${sessionId}; in ${waitMs}ms): ${String(error)}`);
                    // Disposal must allow this bounded handle-release wait to finish.
                    await retryDelay(waitMs);
                }
            }
        })();
        this.unusedSessionCleanups.set(sessionId, cleanup);
        try {
            await cleanup;
        }
        finally {
            if (this.unusedSessionCleanups.get(sessionId) === cleanup)
                this.unusedSessionCleanups.delete(sessionId);
        }
    }
    closeStandbyInBackground(standby) {
        void this.discardStandby(standby).catch(error => {
            this.host.log.warn(`antigravity-acp: standby close failed: ${String(error)}`);
        });
    }
    async discardStandby(standby) {
        const index = this.standbyPool.indexOf(standby);
        // An earlier close may have yielded while another chat claimed this slot.
        if (index < 0 || standby.boundConversation !== undefined)
            return;
        this.standbyPool.splice(index, 1);
        this.standbyTenants.delete(standby.tenantKey);
        this.bridge.forgetTenant(standby.tenantKey);
        await this.closeUnusedSession(standby.process, standby.sessionId);
        if (this.process !== undefined)
            this.refillStandbyPool(this.process);
    }
    handleSessionUpdate(conv, update) {
        if (update.content?.type === 'text' && update.content.text) {
            if (update.sessionUpdate === 'agent_thought_chunk')
                conv.timing?.first('first_thought', { sessionId: conv.sessionId });
            if (update.sessionUpdate === 'agent_message_chunk')
                conv.timing?.first('first_text', { sessionId: conv.sessionId });
        }
        if (update.sessionUpdate === 'tool_call')
            conv.timing?.mark('acp_tool_call_received', { sessionId: conv.sessionId, ...update.toolCallId !== undefined ? { callId: update.toolCallId } : {} });
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
            conv.configOptions = update.configOptions;
            if (this.catalog.observe(update.configOptions))
                this.host.onModelsChanged?.();
            // A parked call can be corrected before its result is released. A
            // change during generation invalidates the active response instead.
            if (!conv.selecting && conv.turn !== undefined && conv.turn.pendingCalls.size === 0
                && conv.model !== undefined && conv.effort !== undefined) {
                const error = this.selectionError(conv, conv.model, conv.effort);
                if (error !== undefined && conv.configurationError === undefined) {
                    conv.configurationError = error;
                    this.host.log.warn(`antigravity-acp: ${error.message}`);
                    conv.process?.cancel(conv.sessionId);
                    conv.turn.events.push({ kind: 'error', error });
                }
            }
        }
        if (recordReportedToolCall(conv, update) === 'conflict') {
            this.host.log.warn(`antigravity-acp: agent reported conflicting identity for tool call ${String(update.toolCallId)}`);
        }
        conv.turn?.onUpdate(update);
    }
    targetStandbyPoolSize() {
        const now = Date.now();
        const activeMain = [...this.conversations.values()].filter(c => c.purpose === MAIN_PURPOSE
            && (c.opening || c.turn !== undefined || now - c.lastUsed < 60_000)).length;
        const preferred = activeMain > 1 ? this.maxStandbyPoolSize : 1;
        const occupied = this.liveSessionSlots.size - this.standbyPool.length;
        return Math.max(0, Math.min(preferred, this.host.config.maxLiveSessions - occupied));
    }
    refillStandbyPool(proc) {
        if (this.standbyEnabled
            && !this.disposed
            && proc === this.process
            && proc.alive
            && this.standbyPool.length < this.targetStandbyPoolSize()
            && this.standbyPromise === undefined
            && Date.now() >= this.standbyRetryAt) {
            void this.warmStandbySession(proc);
        }
    }
    warmStandbySession(proc) {
        if (this.disposed || !this.standbyEnabled || !this.standbyContextKnown
            || proc !== this.process || !proc.alive || Date.now() < this.standbyRetryAt) {
            return Promise.resolve(undefined);
        }
        const existing = this.standbyPool.find(s => s.process === proc && s.contextKey === this.standbyContext.key && proc.alive);
        if (existing !== undefined && this.standbyPool.length >= this.targetStandbyPoolSize()) {
            return Promise.resolve(existing);
        }
        if (this.standbyPromise !== undefined)
            return this.standbyPromise;
        const context = this.standbyContext;
        const targetModel = this.lastMainModel;
        const targetEffort = targetModel === undefined ? undefined : this.effectiveEffort(targetModel, this.lastMainEffort ?? this.defaultEffort());
        this.standbyPendingContext = context;
        this.standbyPendingProcess = proc;
        this.standbyPromise = (async () => {
            this.syncOAuthTokenIfNeeded();
            // A template copies native initialization, never a prompted session's history.
            // A different context can only take a separately initialized session.
            const { system, tools } = context;
            const { advertisedTools, nativeToolBaselines, knownTools } = this.nativeTools(tools);
            const advertisedToolNames = new Set(advertisedTools.map(tool => tool.name));
            const tenantKey = randomBytes(16).toString('hex');
            const tenantSecret = randomBytes(24).toString('hex');
            this.standbyTenants.set(tenantKey, { secret: tenantSecret, tools: advertisedTools });
            const standby = {
                contextKey: context.key,
                sessionId: '',
                process: proc,
                tenantKey,
                tenantSecret,
                configOptions: [],
                system,
                advertisedTools,
                nativeToolBaselines,
                advertisedToolNames,
                knownTools,
                reportedToolCalls: new Map(),
                boundConversation: undefined,
                model: undefined,
                effort: undefined,
            };
            try {
                const result = await this.newTrackedSession(proc, {
                    cwd: this.preflight?.workspace ?? this.home,
                    mcpServers: [{
                            type: 'http',
                            name: MCP_SERVER_NAME,
                            url: `${this.bridge.url}/${tenantKey}`,
                            headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }],
                        }],
                    _meta: { antigravity: { disableBuiltInTools: true, systemPrompt: { append: bridgeSystemPrompt(system) } } },
                }, this.createSlotHandlers(standby, tenantKey), true);
                if (result === undefined) {
                    this.standbyTenants.delete(tenantKey);
                    this.bridge.forgetTenant(tenantKey);
                    return undefined;
                }
                standby.sessionId = result.sessionId;
                if (this.catalog.observe(result.configOptions, result.models?.availableModels)) {
                    this.host.onModelsChanged?.();
                }
                if (this.disposed || context.key !== this.standbyContext.key || proc !== this.process || !proc.alive || this.standbyPool.length >= this.maxStandbyPoolSize) {
                    this.standbyTenants.delete(tenantKey);
                    this.bridge.forgetTenant(tenantKey);
                    await this.closeUnusedSession(proc, result.sessionId);
                    return undefined;
                }
                standby.sessionId = result.sessionId;
                if (result.configOptions !== undefined)
                    standby.configOptions = result.configOptions;
                const initialModel = standby.configOptions.find(o => o.id === 'model' || o.category === 'model')?.currentValue;
                const initialLevel = asEffort(standby.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level')?.currentValue);
                standby.model = initialModel;
                standby.effort = initialLevel;
                if (targetModel !== undefined && targetEffort !== undefined) {
                    await this.preconfigureStandby(standby, proc, targetModel, targetEffort);
                }
                if (this.disposed || context.key !== this.standbyContext.key || proc !== this.process || !proc.alive || this.standbyPool.length >= this.maxStandbyPoolSize) {
                    this.standbyTenants.delete(tenantKey);
                    this.bridge.forgetTenant(tenantKey);
                    await this.closeUnusedSession(proc, result.sessionId);
                    return undefined;
                }
                this.standbyPool.push(standby);
                this.standbyFailures = 0;
                this.standbyRetryAt = 0;
                if (this.standbyRetryTimer !== undefined)
                    clearTimeout(this.standbyRetryTimer);
                this.standbyRetryTimer = undefined;
                return standby;
            }
            catch (error) {
                this.standbyTenants.delete(tenantKey);
                this.bridge.forgetTenant(tenantKey);
                if (standby.sessionId.length > 0)
                    await this.closeUnusedSession(proc, standby.sessionId);
                if (!this.disposed && proc === this.process && proc.alive) {
                    const retryMs = Math.min(60_000, 5_000 * 2 ** Math.min(this.standbyFailures++, 4));
                    this.standbyRetryAt = Date.now() + retryMs;
                    this.host.log.warn(`antigravity-acp: standby warmup failed; retry in ${retryMs}ms: ${error instanceof Error ? error.message : String(error)}`);
                    if (this.standbyRetryTimer !== undefined)
                        clearTimeout(this.standbyRetryTimer);
                    this.standbyRetryTimer = setTimeout(() => {
                        this.standbyRetryTimer = undefined;
                        this.refillStandbyPool(proc);
                    }, retryMs);
                    this.standbyRetryTimer.unref?.();
                }
                return undefined;
            }
        })().finally(() => {
            this.standbyPromise = undefined;
            this.standbyPendingContext = undefined;
            this.standbyPendingProcess = undefined;
            if (this.standbyPool.length < this.targetStandbyPoolSize()) {
                this.refillStandbyPool(proc);
            }
        });
        return this.standbyPromise;
    }
    async preconfigureStandby(standby, proc, model, effort) {
        try {
            const modelOption = standby.configOptions.find(o => o.id === 'model' || o.category === 'model');
            if (modelOption?.options !== undefined && !modelOption.options.some(o => o.value === model))
                return;
            await this.select(standby, proc, model, effort);
        }
        catch (error) {
            this.host.log.warn(`antigravity-acp: standby configuration failed; foreground selection will retry: ${String(error)}`);
        }
    }
    createSlotHandlers(slot, tenantKey) {
        return {
            onUpdate: (update) => {
                if (slot.boundConversation !== undefined) {
                    this.handleSessionUpdate(slot.boundConversation, update);
                    return;
                }
                if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
                    slot.configOptions = update.configOptions;
                    if (this.catalog.observe(update.configOptions))
                        this.host.onModelsChanged?.();
                }
                recordReportedToolCall(slot, update);
            },
            onPermission: (request) => {
                if (slot.boundConversation !== undefined) {
                    return this.answerPermission(slot.boundConversation, request);
                }
                const allowOnce = request.options.find(o => o.kind === 'allow_once');
                if (request.toolCall?.kind === 'other' && isEmptyInput(request.toolCall.rawInput) && this.bridge.hasHandshake(tenantKey) && allowOnce !== undefined) {
                    return { outcome: 'selected', optionId: allowOnce.optionId };
                }
                const rejectOnce = request.options.find(o => o.kind === 'reject_once');
                return rejectOnce !== undefined ? { outcome: 'selected', optionId: rejectOnce.optionId } : { outcome: 'cancelled' };
            },
        };
    }
    async takeStandbySession(proc, system, tools, preferredModel, preferredEffort, signal) {
        signal?.throwIfAborted();
        if (this.disposed)
            return undefined;
        const contextKey = contentDigest({ system, tools });
        const pick = async () => {
            signal?.throwIfAborted();
            for (const entry of [...this.standbyPool]) {
                if (!this.standbyPool.includes(entry))
                    continue;
                if (entry.process !== proc || !proc.alive || entry.contextKey !== this.standbyContext.key
                    || entry.system !== this.standbyContext.system || entry.boundConversation !== undefined) {
                    this.closeStandbyInBackground(entry);
                }
            }
            // Closing yields to concurrent requests/refills. Recheck this request's
            // fingerprint at selection, independently of the latest template.
            const matches = (entry) => entry.process === proc && proc.alive
                && entry.contextKey === contextKey && entry.system === system && entry.boundConversation === undefined;
            const claim = (index) => {
                const entry = this.standbyPool[index];
                try {
                    if (this.unusedSessions.get(entry.sessionId) !== entry.process
                        || !this.unusedSessionLedger.ownedBy(entry.sessionId)) {
                        throw new Error('Standby unused-session ownership is missing');
                    }
                }
                catch (error) {
                    this.host.log.warn(`antigravity-acp: standby ownership could not be verified before adoption (${entry.sessionId}): ${String(error)}`);
                    this.closeStandbyInBackground(entry);
                    return undefined;
                }
                // Binding is still pre-prompt setup; startPrompt retires both paths.
                return this.standbyPool.splice(index, 1)[0];
            };
            if (preferredModel !== undefined) {
                const exactIdx = this.standbyPool.findIndex(s => matches(s) && s.model === preferredModel && (preferredEffort === undefined || s.effort === preferredEffort));
                if (exactIdx >= 0)
                    return claim(exactIdx);
                const modelIdx = this.standbyPool.findIndex(s => matches(s) && s.model === preferredModel);
                if (modelIdx >= 0)
                    return claim(modelIdx);
            }
            const index = this.standbyPool.findIndex(matches);
            return index < 0 ? undefined : claim(index);
        };
        const immediate = await pick();
        if (immediate !== undefined)
            return immediate;
        if (this.standbyEnabled && this.standbyPromise !== undefined
            && this.standbyPendingContext?.key === contextKey && this.standbyPendingProcess === proc) {
            await withAbort(this.standbyPromise, signal);
            return pick();
        }
        return undefined;
    }
    bindStandbySession(conv, standby) {
        standby.boundConversation = conv;
        this.standbyTenants.delete(standby.tenantKey);
        this.tenants.set(standby.tenantKey, conv);
        conv.standbySlot = standby;
        conv.tenantKey = standby.tenantKey;
        conv.tenantSecret = standby.tenantSecret;
        conv.sessionId = standby.sessionId;
        conv.process = standby.process;
        conv.configOptions = standby.configOptions;
        conv.systemHash = digest(standby.system);
        conv.advertisedTools = [...standby.advertisedTools];
        conv.nativeToolBaselines = [...standby.nativeToolBaselines];
        conv.advertisedToolNames = new Set(standby.advertisedToolNames);
        conv.knownTools = new Map(standby.knownTools);
        conv.reportedToolCalls.clear();
        for (const [id, meta] of standby.reportedToolCalls) {
            conv.reportedToolCalls.set(id, meta);
        }
        standby.reportedToolCalls.clear();
        conv.model = standby.model;
        conv.effort = standby.effort;
        conv.usageReader = undefined;
        conv.knownHistory = undefined;
        conv.emittedAssistant = undefined;
        conv.dirty = false;
        conv.issuedIds.clear();
    }
    async openSession(conv, system, tools, proc, signal, persisted) {
        signal?.throwIfAborted();
        if (persisted === undefined && conv.purpose === MAIN_PURPOSE) {
            const standby = await this.takeStandbySession(proc, system, tools, this.lastMainModel, this.lastMainEffort, signal);
            if (standby !== undefined) {
                this.bindStandbySession(conv, standby);
                this.refillStandbyPool(proc);
                return;
            }
        }
        this.syncOAuthTokenIfNeeded();
        conv.reportedToolCalls.clear();
        const native = persisted === undefined ? this.nativeTools(tools) : {
            advertisedTools: structuredClone(persisted.advertisedTools),
            nativeToolBaselines: structuredClone(persisted.nativeToolBaselines),
            knownTools: new Map(structuredClone(persisted.knownTools)),
        };
        conv.advertisedTools = native.advertisedTools;
        conv.nativeToolBaselines = native.nativeToolBaselines;
        conv.knownTools = native.knownTools;
        conv.advertisedToolNames = new Set(conv.advertisedTools.map(t => t.name));
        const attachMcp = tools.length > 0 || conv.purpose === MAIN_PURPOSE;
        const tenantKey = attachMcp ? randomBytes(16).toString('hex') : undefined;
        const tenantSecret = tenantKey !== undefined ? randomBytes(24).toString('hex') : undefined;
        const mcpServers = tenantKey !== undefined && tenantSecret !== undefined
            ? [{ type: 'http', name: MCP_SERVER_NAME, url: `${this.bridge.url}/${tenantKey}`, headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }] }]
            : [];
        conv.tenantKey = tenantKey;
        conv.tenantSecret = tenantSecret;
        if (tenantKey !== undefined)
            this.tenants.set(tenantKey, conv);
        const slot = conv.purpose === MAIN_PURPOSE && tenantKey !== undefined && tenantSecret !== undefined
            ? {
                contextKey: contentDigest({ system, tools }),
                sessionId: '',
                process: proc,
                tenantKey,
                tenantSecret,
                configOptions: [],
                system,
                advertisedTools: [...conv.advertisedTools],
                nativeToolBaselines: [...conv.nativeToolBaselines],
                advertisedToolNames: new Set(conv.advertisedToolNames),
                knownTools: new Map(conv.knownTools),
                reportedToolCalls: new Map(),
                boundConversation: conv,
                model: undefined,
                effort: undefined,
            }
            : undefined;
        const systemPrompt = conv.purpose === COMPACTION_PURPOSE
            ? [system, COMPACTION_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
            : conv.purpose === TEXT_ONLY_PURPOSE
                ? [system, TEXT_ONLY_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
                : bridgeSystemPrompt(system);
        try {
            const result = await this.newTrackedSession(proc, {
                cwd: this.preflight?.workspace ?? this.home,
                mcpServers,
                _meta: { antigravity: { disableBuiltInTools: true, systemPrompt: { append: systemPrompt } } },
            }, slot !== undefined
                ? this.createSlotHandlers(slot, tenantKey)
                : {
                    onUpdate: update => this.handleSessionUpdate(conv, update),
                    onPermission: request => this.answerPermission(conv, request),
                }, false, signal, persisted?.sessionId);
            if (result === undefined)
                throw new LlmError('Antigravity session capacity exhausted', 'RATE_LIMIT');
            conv.sessionId = result.sessionId;
            conv.process = proc;
            conv.configOptions = result.configOptions ?? [];
            if (slot !== undefined) {
                slot.sessionId = result.sessionId;
                slot.configOptions = conv.configOptions;
                conv.standbySlot = slot;
            }
            conv.model = undefined;
            conv.effort = undefined;
            conv.usageReader = undefined;
            conv.dirty = false;
            conv.issuedIds.clear();
            if (this.catalog.observe(result.configOptions, result.models?.availableModels))
                this.host.onModelsChanged?.();
        }
        catch (error) {
            this.releaseTenant(conv);
            conv.standbySlot = undefined;
            conv.tenantKey = undefined;
            conv.tenantSecret = undefined;
            conv.advertisedTools = [];
            conv.nativeToolBaselines = [];
            conv.advertisedToolNames.clear();
            conv.knownTools.clear();
            throw mapError(error);
        }
    }
    /** Keep cold and standby native declarations, lowering, and routing baselines identical. */
    nativeTools(tools) {
        const advertisedTools = [];
        const nativeToolBaselines = [];
        const knownTools = new Map();
        for (const tool of tools) {
            // agy can omit large full declarations from the provider's native list.
            // Keep the established compaction/fallback path above the native budget.
            const baseline = compactBridgeTool(tool);
            let wire = baseline;
            if (toolState(tool).hasNonStringEnum) {
                if (this.host.config.numericEnumMode === 'dispatch')
                    continue;
                const lowered = lowerNumericEnums(baseline);
                if (lowered === undefined)
                    continue;
                wire = lowered.tool;
            }
            advertisedTools.push(freezeBridgeTool(wire));
            nativeToolBaselines.push(tool);
            // Known host constraints and prose are separate from their wire encoding.
            if (isWithinNativeToolBudget(baseline))
                knownTools.set(tool.name, {
                    ...toolState(baseline), description: wire.description, schemaDescriptions: toolState(wire).schemaDescriptions,
                });
        }
        return { advertisedTools, nativeToolBaselines, knownTools };
    }
    /** Constant-time check of one tenant's current bearer credential. */
    authorizeTenant(tenantKey, bearerToken) {
        if (tenantKey === undefined || bearerToken === undefined)
            return false;
        const secret = this.tenants.get(tenantKey)?.tenantSecret ?? this.standbyTenants.get(tenantKey)?.secret;
        if (secret === undefined)
            return false;
        const left = Buffer.from(bearerToken, 'utf8');
        const right = Buffer.from(secret, 'utf8');
        if (left.length !== right.length) {
            timingSafeEqual(left, left);
            return false;
        }
        return timingSafeEqual(left, right);
    }
    /** Drop one conversation's tenant registration together with its bridge handshake evidence. */
    releaseTenant(conv) {
        if (conv.tenantKey === undefined)
            return;
        this.tenants.delete(conv.tenantKey);
        this.bridge.forgetTenant(conv.tenantKey);
    }
    /**
     * Decide one `session/request_permission` from structured host-reported
     * metadata only. `title` and `rawInput` are never matched against tool
     * names: a native tool whose payload merely contains `mcp_omp_…` or a
     * spoofed title must not unlock the bridge.
     */
    answerPermission(conv, request) {
        const pick = (kind) => {
            const option = request.options.find(o => o.kind === kind);
            return option === undefined ? undefined : { outcome: 'selected', optionId: option.optionId };
        };
        const reject = (reason) => {
            this.host.log.warn(`antigravity-acp: refused permission request (${reason}): ${request.toolCall?.title ?? 'unknown'}`);
            return pick('reject_once') ?? { outcome: 'cancelled' };
        };
        if (conv.sessionId === undefined || request.sessionId !== conv.sessionId)
            return reject('session mismatch');
        if (conv.tenantKey === undefined)
            return reject('no MCP bridge is mounted for this session');
        if (conv.turn === undefined || conv.turn.finished)
            return reject('no live turn');
        if (conv.configurationError !== undefined)
            return reject('unconfirmed model configuration');
        const toolCallId = request.toolCall?.toolCallId;
        if (typeof toolCallId !== 'string' || toolCallId.length === 0)
            return reject('missing toolCallId');
        const reported = conv.reportedToolCalls.get(toolCallId);
        const claimed = structuredToolMeta(request.toolCall);
        if (reported === undefined) {
            // Nothing the agent reported in `session/update` backs this call: its own
            // in-request metadata is untrusted (stale or cross-session toolCallId).
            if (claimed.serverName !== undefined || claimed.toolName !== undefined) {
                return reject(`tool call ${toolCallId} was never reported by the agent`);
            }
            // The only identity-less exception is the agent's MCP loading probe
            // (no tool name, no input), and it must be bound to explicit evidence:
            // this tenant itself completed the MCP handshake with its bearer secret.
            // Even then the probe is never granted `allow_always`.
            if (request.toolCall?.kind === 'other' && isEmptyInput(request.toolCall.rawInput)) {
                if (!this.bridge.hasHandshake(conv.tenantKey)) {
                    return reject('identity-less probe without a completed MCP handshake');
                }
                return pick('allow_once') ?? { outcome: 'cancelled' };
            }
            return reject('missing structured tool metadata');
        }
        if (reported.conflict === true) {
            return reject(`reported identity of tool call ${toolCallId} conflicts across agent updates`);
        }
        if (claimed.serverName !== undefined && claimed.serverName !== reported.serverName)
            return reject('MCP server name conflict');
        if (claimed.toolName !== undefined && claimed.toolName !== reported.toolName)
            return reject('tool name conflict');
        if (reported.serverName !== MCP_SERVER_NAME)
            return reject(`unknown MCP server ${reported.serverName ?? '(none)'}`);
        const allowedTools = new Set([...conv.advertisedToolNames, ...conv.toolNames, AWAIT_TOOL_NAME, CALL_TOOL_NAME]);
        if (reported.toolName === undefined || !allowedTools.has(reported.toolName)) {
            return reject(`tool is not offered to this session: ${reported.toolName ?? '(none)'}`);
        }
        return pick('allow_once') ?? { outcome: 'cancelled' };
    }
    selectionError(conv, model, effort) {
        if (typeof model !== 'string' || !model || asEffort(effort) === undefined)
            return new LlmError('Antigravity configuration cannot be confirmed without a model and reasoning effort', 'CONFIG_MISMATCH');
        const modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model');
        if (modelOption?.currentValue !== model)
            return new LlmError(`Antigravity configuration mismatch: requested model ${model}, reported ${modelOption?.currentValue ?? '(missing)'}`, 'CONFIG_MISMATCH');
        if (this.catalog.fixedEffort(model) === effort)
            return undefined;
        const option = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level');
        if (option?.currentValue !== effort)
            return new LlmError(`Antigravity configuration mismatch for ${model}: requested thought_level=${effort}, reported ${option?.currentValue ?? '(missing)'}`, 'CONFIG_MISMATCH');
        return undefined;
    }
    assertSelection(conv, model, effort) {
        const error = conv.configurationError ?? this.selectionError(conv, model, effort);
        if (error !== undefined) throw error;
    }
    async select(conv, proc, model, effort, { confirm = false, phase } = {}) {
        this.effectiveEffort(model, effort);
        conv.selecting = true;
        try {
            const sessionId = conv.sessionId;
            const modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model');
            if (modelOption?.options !== undefined && !modelOption.options.some(o => o.value === model)) {
                throw new LlmError(`Antigravity does not offer model "${model}" to this account; available: ${modelOption.options.map(o => o.value).join(', ')}`, 'UNKNOWN_MODEL');
            }
            let switched = false;
            const write = async (id, category, value) => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    conv.configOptions = await proc.setConfigOption(sessionId, id, value).catch(error => { throw mapError(error); });
                    const option = conv.configOptions.find(o => o.id === id || o.category === category);
                    if (option?.currentValue === value)
                        return;
                }
                throw new LlmError(`Antigravity did not apply ${id}=${value}`, 'TRANSPORT');
            };
            const needModel = modelOption?.currentValue !== undefined ? modelOption.currentValue !== model : conv.model !== model;
            if (needModel) {
                await write(modelOption?.id ?? 'model', 'model', model);
                switched = true;
            }
            // A model change replaces all options and can reset the reasoning level.
            const updatedLevelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level');
            if (this.catalog.fixedEffort(model) === undefined) {
                if (updatedLevelOption === undefined || (Array.isArray(updatedLevelOption.options)
                    && !updatedLevelOption.options.some(option => option.value === effort)))
                    throw new LlmError(`Antigravity does not offer thought_level=${effort} for ${model}`, 'EFFORT_UNAVAILABLE');
                const changed = updatedLevelOption.currentValue !== effort;
                if (confirm || changed) await write(updatedLevelOption.id, 'thought_level', effort);
                switched ||= changed;
            }
            this.assertSelection(conv, model, effort);
            conv.model = model;
            conv.effort = effort;
            if (conv.standbySlot !== undefined) {
                conv.standbySlot.model = model;
                conv.standbySlot.effort = effort;
            }
            if (confirm)
                this.host.log.info(`antigravity-acp: configuration confirmed ${JSON.stringify({ sessionId, model, requestedEffort: effort, confirmedEffort: effort, phase })}`);
            return switched;
        }
        finally { conv.selecting = false; }
    }
    plan(conv, system, messages, history) {
        const reusable = conv.sessionId !== undefined
            && !conv.dirty
            && conv.purpose === MAIN_PURPOSE
            && this.historyPrefixIntact(conv, system, history);
        if (reusable) {
            const known = conv.knownHistory;
            let rest = messages.slice(known.length);
            let skip = 0;
            while (skip < rest.length && this.isOwn(conv, rest[skip]))
                skip++;
            rest = rest.slice(skip);
            if (rest.length > 0 && rest.every(m => m.role === 'user' || m.role === 'developer' || m.role === 'system')) {
                return { rebuild: false, history: [], input: rest };
            }
        }
        let cut = messages.length;
        while (cut > 0) {
            const role = messages[cut - 1]?.role;
            if (role !== 'user' && role !== 'developer' && role !== 'system')
                break;
            cut--;
        }
        return { rebuild: true, history: messages.slice(0, cut), input: messages.slice(cut) };
    }
    /**
     * Whether the live ACP session's context is still an exact prefix of the
     * request's message history. A compaction checkpoint or a pruned/rewritten
     * prefix or changed leading system prompt forces a rebuild. Appending new
     * policy text cannot revoke earlier native instructions or private data.
     * @param conv - conversation owning the ACP session.
     * @param system - current OMP system prompt.
     * @param history - current model-facing fingerprints after leading system messages.
     * @returns true when only new messages were appended.
     */
    historyPrefixIntact(conv, system, history) {
        if (conv.knownHistory === undefined)
            return false;
        const known = conv.knownHistory;
        const intact = known.length <= history.length
            && known.every((entry, index) => history[index]?.id === entry.id && history[index]?.fingerprint === entry.fingerprint);
        if (!intact)
            return false;
        // The latest output is already native ACP history even though it was not
        // present in the preceding OMP request. Check it before skipping own output.
        if (conv.emittedAssistant !== undefined && history[known.length]?.fingerprint !== conv.emittedAssistant)
            return false;
        return conv.systemHash === digest(system);
    }
    isOwn(conv, message) {
        if (message.role === 'assistant')
            return message.source.kind === 'model' && message.source.provider === this.host.config.provider;
        if (message.role === 'tool')
            return conv.issuedIds.has(message.toolCallId);
        return false;
    }
    async resetSession(conv, keepPersisted = false) {
        if (keepPersisted)
            this.persistConversation(conv);
        else
            this.sessions.forget(conv.key);
        const sessionId = conv.sessionId;
        const proc = conv.process;
        if (conv.standbySlot !== undefined) {
            conv.standbySlot.boundConversation = undefined;
            conv.standbySlot = undefined;
        }
        this.releaseTenant(conv);
        conv.sessionId = undefined;
        conv.tenantKey = undefined;
        conv.tenantSecret = undefined;
        conv.process = undefined;
        conv.advertisedTools = [];
        conv.nativeToolBaselines = [];
        conv.advertisedToolNames.clear();
        conv.knownTools.clear();
        conv.reportedToolCalls.clear();
        conv.usageReader = undefined;
        conv.knownHistory = undefined;
        conv.emittedAssistant = undefined;
        conv.issuedIds.clear();
        conv.model = undefined;
        conv.effort = undefined;
        conv.configurationError = undefined;
        conv.dirty = false;
        if (sessionId !== undefined && proc !== undefined) {
            if (this.unusedSessions.get(sessionId) === proc)
                await this.closeUnusedSession(proc, sessionId);
            else
                await this.closeTrackedSession(proc, sessionId);
        }
    }
    /**
     * Retire a conversation's session and revoke its tenant. Only never-prompted
     * sessions created by the pre-warmer may enter the shared standby pool.
     */
    async recycleSession(conv) {
        await this.resetSession(conv, true);
        if (this.process !== undefined)
            this.refillStandbyPool(this.process);
        return false;
    }
    startPrompt(conv, proc, blocks) {
        try { this.assertSelection(conv, conv.model, conv.effort); }
        catch (error) { this.dropTurn(conv, 'The model configuration could not be confirmed.'); throw error; }
        const turn = conv.turn;
        if (!this.sessions.forget(conv.key)) {
            conv.turn = undefined;
            conv.dirty = true;
            throw new LlmError('Could not invalidate the durable ACP session before submitting a prompt', 'TRANSPORT');
        }
        conv.usageReader ??= new SessionUsageReader(sessionDbPath(this.home, conv.sessionId), message => this.host.log.warn(message));
        // A claimed standby and a cold session are both unused until this point.
        // Retire ownership before sending: a lost prompt reply must never authorize
        // deletion of a session that could already contain submitted user input.
        if (conv.sessionId !== undefined && this.unusedSessions.get(conv.sessionId) === proc) {
            this.unusedSessionLedger.forget(conv.sessionId);
            this.unusedSessions.delete(conv.sessionId);
        }
        conv.timing?.mark('prompt_sent', { sessionId: conv.sessionId });
        turn.trackPrompt(proc.prompt(conv.sessionId, blocks)).then(result => turn.events.push({ kind: 'done', result }), (error) => turn.events.push({ kind: 'error', error: mapError(error) }));
    }
    async *pump(conv, proc, options, effort) {
        const turn = conv.turn;
        const sessionId = conv.sessionId;
        let finishKind;
        const output = [];
        try {
            for await (const chunk of pumpStep(turn, {
                parkSettleMs: this.host.config.parkSettleMs,
                maxContinuations: this.longDecodeContinuations(),
                continuePrompt: async () => {
                    await this.select(conv, proc, options.model, effort, { confirm: true, phase: 'continuation' });
                    options.signal?.throwIfAborted();
                    this.assertSelection(conv, options.model, effort);
                    conv.timing?.mark('prompt_sent', { sessionId });
                    return turn.trackPrompt(proc.prompt(sessionId, [{ type: 'text', text: CONTINUE_PROMPT }]));
                },
                cancel: () => proc.cancel(sessionId),
                recordUsage: (usage, steps) => {
                    this.lastTurn = { model: options.model, effort, steps, ...usage !== undefined ? { usage } : {}, at: new Date().toISOString() };
                },
                consumeStepUsage: async ({ final } = {}) => {
                    let batch = conv.usageReader?.read(final);
                    for (let attempt = 0; batch === undefined && attempt < 3; attempt++) {
                        await delay(15);
                        batch = conv.usageReader?.read(final);
                    }
                    if (batch === undefined)
                        return undefined;
                    if (batch.usage.thoughtTokens === 0 && batch.usage.outputTokens > 0)
                        this.host.log.info(`antigravity-acp: zero-thought usage sample ${JSON.stringify({ sessionId, requestedEffort: effort,
                            confirmedEffort: conv.effort, cachedReadTokens: batch.usage.cachedReadTokens ?? 0, outputTokens: batch.usage.outputTokens, exact: batch.exact === true })}`);
                    turn.recordStepBatch(batch);
                    return batch;
                },
            }, options.signal)) {
                if (conv.configurationError !== undefined) throw conv.configurationError;
                if (chunk.type === 'block-end') {
                    output.push(structuredClone(chunk.block));
                    if (chunk.block.type === 'tool-call')
                        conv.issuedIds.add(chunk.block.id);
                }
                if (chunk.type === 'finish') {
                    finishKind = chunk.reason.kind;
                    conv.emittedAssistant = output.length > 0 ? contentDigest({ role: 'assistant', content: output }) : undefined;
                    if (finishKind === 'tool-calls') {
                        for (const call of turn.pendingCalls.values()) {
                            conv.timing?.mark('tool_handoff', { sessionId, callId: call.id, tool: call.name });
                        }
                    }
                    conv.timing?.mark('step_finished', { sessionId, outcome: finishKind });
                }
                yield chunk;
            }
        }
        catch (error) {
            this.dropTurn(conv, 'The harness request failed.');
            throw mapError(error);
        }
        finally {
            // Closing the iterator also ends the step. Only a completed tool handoff
            // keeps its ACP turn alive for OMP to supply the results.
            if (finishKind !== 'tool-calls') {
                if (finishKind === undefined) {
                    this.dropTurn(conv, 'The harness stopped reading this request.');
                }
                else if (finishKind === 'aborted') {
                    // A cancelled turn leaves partial agent-side history; rebuild from OMP history next time.
                    await turnSettled(turn, 5_000);
                    conv.dirty = true;
                }
                conv.reportedToolCalls.clear();
                conv.turn = undefined;
                if (finishKind === 'stop' || finishKind === 'max-tokens')
                    this.persistConversation(conv);
                else
                    this.sessions.forget(conv.key);
            }
        }
    }
    async deliverResults(conv, messages, proc, tools, signal, model, effort) {
        const turn = conv.turn;
        const results = new Map();
        let last = -1;
        messages.forEach((message, index) => {
            if (message.role === 'tool' && turn.pendingCalls.has(message.toolCallId)) {
                results.set(message.toolCallId, message);
                last = Math.max(last, index);
            }
        });
        if (results.size !== turn.pendingCalls.size)
            return false;
        const extras = messages.slice(last + 1);
        if (extras.some(m => m.role === 'assistant' || m.role === 'tool'))
            return false;
        const extraText = extras.length > 0 ? renderTranscript(extras) : '';
        const pending = [...turn.pendingCalls.values()];
        for (const call of pending)
            conv.timing?.mark('tool_result_received', { sessionId: conv.sessionId, callId: call.id, tool: call.name });
        // Convert independent results concurrently, then publish the complete
        // batch in call order. A failed image read leaves every call retryable.
        const converted = await Promise.all(pending.map(call => {
            const message = results.get(call.id);
            return this.toBridgeResult(message.content, message.isError === true);
        }));
        signal?.throwIfAborted();
        const failure = turn.nativePrompt?.error;
        if (failure !== undefined) {
            this.dropTurn(conv, 'The native prompt failed before these tool results arrived.');
            throw mapError(failure);
        }
        await this.select(conv, proc, model, effort, { confirm: true, phase: 'tool-resume' });
        signal?.throwIfAborted();
        this.assertSelection(conv, model, effort);
        // The native prompt can settle while image preparation is in flight.
        const live = !turn.finished && this.isTurnLive(turn);
        const toolDelta = consumeToolDelta(conv, tools);
        const suffix = [toolDelta, extraText].filter(Boolean).join('\n\n');
        if (!live) {
            // The agent ended its turn while the harness ran the tools: hand the results over as new input.
            const blocks = [];
            for (const [index, call] of pending.entries()) {
                const result = converted[index];
                blocks.push({ type: 'text', text: `<tool_result id="${call.id}"${result.isError === true ? ' error="true"' : ''}>\n` }, ...result.content, { type: 'text', text: '\n</tool_result>\n\n' });
            }
            blocks.push({ type: 'text', text: `${suffix ? `${suffix}\n\n` : ''}Continue the task with these tool results.` });
            turn.abandon('The native prompt ended; these tool results are continuing in a new prompt.');
            // The old turn is over: its reported identities do not carry into the continuation.
            conv.reportedToolCalls.clear();
            conv.turn = new AcpTurn(this.nextTurnTag(messages));
            this.startPrompt(conv, proc, blocks);
            return true;
        }
        turn.pendingCalls.clear();
        for (const [index, call] of pending.entries()) {
            const result = converted[index];
            if (index === pending.length - 1 && suffix.length > 0)
                result.content.push({ type: 'text', text: `\n\n${suffix}` });
            call.result.resolve(result);
            conv.timing?.mark('tool_result_resolved', { sessionId: conv.sessionId, callId: call.id, tool: call.name });
        }
        return true;
    }
    isTurnLive(turn) {
        return turn.nativePrompt?.settled !== true;
    }
    async toBridgeResult(content, isError) {
        const items = (await Promise.all(content.map(async (block) => {
            if (block.type === 'text') {
                return block.text.length > 0 ? [{ type: 'text', text: block.text }] : [];
            }
            else if (block.type === 'image' && block.offloaded !== true && this.host.canReadImages()) {
                const image = await this.host.readImage(block);
                return image !== undefined
                    ? [{ type: 'image', data: image.data, mimeType: image.mimeType }]
                    : [{ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` }];
            }
            else {
                const rendered = renderTranscript([{ role: 'user', content: [block] }]);
                return rendered.length > 0 ? [{ type: 'text', text: rendered }] : [];
            }
        }))).flat();
        if (items.length === 0)
            items.push({ type: 'text', text: '(no output)' });
        return { content: items, ...isError ? { isError: true } : {} };
    }
    dropTurn(conv, reason) {
        const turn = conv.turn;
        if (turn === undefined)
            return;
        if (!turn.finished && conv.sessionId !== undefined)
            conv.process?.cancel(conv.sessionId);
        turn.abandon(reason);
        conv.turn = undefined;
        conv.dirty = true;
        this.sessions.forget(conv.key);
        conv.reportedToolCalls.clear();
    }
    /** A conversation is idle only when no turn is running and no session is opening. */
    isIdle(conv) {
        return conv.turn === undefined && !conv.opening;
    }
    async afterStep(conv) {
        conv.lastUsed = Date.now();
        const idle = this.isIdle(conv);
        if (idle && (conv.purpose !== MAIN_PURPOSE || conv.key.startsWith('anon-'))) {
            // Retire one-shot calls before recycling can size/refill the main pool.
            this.conversations.delete(conv.key);
            await this.recycleSession(conv);
        }
        else if (idle && conv.sessionId === undefined && this.conversations.get(conv.key) === conv) {
            // A failed opening leaves an unusable empty shell: release its capacity slot.
            this.conversations.delete(conv.key);
        }
        if (this.process !== undefined) {
            for (const standby of [...this.standbyPool]) {
                if (standby.contextKey !== this.standbyContext.key)
                    this.closeStandbyInBackground(standby);
            }
            while (this.standbyPool.length > this.targetStandbyPoolSize()) {
                await this.discardStandby(this.standbyPool[0]);
            }
            this.refillStandbyPool(this.process);
        }
    }
    listTools(tenantKey) {
        const conv = tenantKey === undefined ? undefined : this.tenants.get(tenantKey);
        if (conv !== undefined)
            return [...conv.advertisedTools, AWAIT_TOOL, CALL_TOOL];
        const standby = tenantKey === undefined ? undefined : this.standbyTenants.get(tenantKey);
        if (standby !== undefined)
            return [...standby.tools, AWAIT_TOOL, CALL_TOOL];
        return [];
    }
    async callTool(request) {
        // Only the tenant mounted for this exact conversation may drive its tools;
        // a bare `conversationId` never grants routing on its own.
        const conv = request.tenantKey !== undefined ? this.tenants.get(request.tenantKey) : undefined;
        if (conv === undefined) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (conv.configurationError !== undefined)
            return { content: [{ type: 'text', text: conv.configurationError.message }], isError: true };
        if (request.conversationId !== undefined && (conv.sessionId === undefined || request.conversationId !== conv.sessionId)) {
            return { content: [{ type: 'text', text: 'Tenant session mismatch.' }], isError: true };
        }
        const turn = conv.turn;
        if (turn === undefined || turn.finished) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (request.name === AWAIT_TOOL_NAME) {
            const callId = typeof request.arguments.call_id === 'string' ? request.arguments.call_id : '';
            const call = turn.calls.get(callId);
            if (call === undefined)
                return { content: [{ type: 'text', text: `Unknown harness call id ${callId}.` }], isError: true };
            turn.relaying = false;
            return this.awaitCall(turn, call, request.signal);
        }
        if (request.name === CALL_TOOL_NAME) {
            const rawTarget = typeof request.arguments.name === 'string' ? request.arguments.name.trim() : '';
            const targetName = rawTarget.startsWith(AGENT_TOOL_PREFIX) ? rawTarget.slice(AGENT_TOOL_PREFIX.length) : rawTarget;
            const rawArgs = request.arguments.arguments;
            if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
                return { content: [{ type: 'text', text: 'Tool arguments must be an object.' }], isError: true };
            }
            const targetArgs = (rawArgs ?? {});
            if (!conv.toolNames.has(targetName)) {
                return { content: [{ type: 'text', text: `The harness has no tool named ${targetName}.` }], isError: true };
            }
            const invalid = invalidNumericEnum(conv.numericEnumRules.get(targetName), targetArgs);
            if (invalid !== undefined) {
                this.host.log.info(`antigravity-acp: tool_rejected ${JSON.stringify({ tool: targetName, reason: 'numeric_enum' })}`);
                conv.timing?.mark('tool_rejected', { sessionId: conv.sessionId, tool: targetName, reason: 'numeric_enum' });
                return { content: [{ type: 'text', text: invalid }], isError: true };
            }
            const call = turn.park(targetName, targetArgs);
            conv.timing?.mark('tool_received', { sessionId: conv.sessionId, callId: call.id, tool: call.name });
            return this.awaitCall(turn, call, request.signal);
        }
        if (!conv.toolNames.has(request.name)) {
            return { content: [{ type: 'text', text: `The harness has no tool named ${request.name}.` }], isError: true };
        }
        const args = hostArguments(request.arguments, conv.nativeToolBaselines.find(tool => tool.name === request.name));
        const invalid = invalidNumericEnum(conv.numericEnumRules.get(request.name), args);
        if (invalid !== undefined) {
            this.host.log.info(`antigravity-acp: tool_rejected ${JSON.stringify({ tool: request.name, reason: 'numeric_enum' })}`);
            conv.timing?.mark('tool_rejected', { sessionId: conv.sessionId, tool: request.name, reason: 'numeric_enum' });
            return { content: [{ type: 'text', text: invalid }], isError: true };
        }
        const call = turn.park(request.name, args);
        conv.timing?.mark('tool_received', { sessionId: conv.sessionId, callId: call.id, tool: call.name });
        return this.awaitCall(turn, call, request.signal);
    }
    async awaitCall(turn, call, signal) {
        let timer;
        const relayAfterMs = this.host.relayAfterMs ?? this.host.config.relayAfterMs ?? DEFAULT_RELAY_AFTER_MS;
        const relay = new Promise(resolve => { timer = setTimeout(() => resolve('relay'), relayAfterMs); });
        const aborted = new Promise(resolve => {
            if (signal.aborted)
                resolve('aborted');
            else
                signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        try {
            const outcome = await Promise.race([call.result.promise, relay, aborted]);
            if (outcome === 'relay') {
                turn.relaying = true;
                return relayNotice(call);
            }
            if (outcome === 'aborted')
                return { content: [{ type: 'text', text: 'The tool call was cancelled.' }], isError: true };
            return outcome;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    sweep() {
        const ttl = this.host.config.idleSessionTtlMs;
        const now = Date.now();
        for (const conv of [...this.conversations.values()]) {
            if (this.isIdle(conv) && now - conv.lastUsed > ttl) {
                this.conversations.delete(conv.key);
                void this.recycleSession(conv);
            }
        }
    }
    /**
     * Mint a fresh 48-bit hex turn tag (`agy_<tag>_<n>`) disjoint from every
     * call id already issued by this runtime or present in `messages`, so
     * multi-turn tool calls and derived `<rootCallId>:ptc:<n>` sub-call ids
     * never collide within a durable session.
     */
    nextTurnTag(messages) {
        collectUsedTurnTags(messages, this.usedTurnTags);
        for (;;) {
            const candidate = randomBytes(6).toString('hex');
            if (!this.usedTurnTags.has(candidate)) {
                this.usedTurnTags.add(candidate);
                return candidate;
            }
        }
    }
}
function collectUsedTurnTags(messages, into) {
    const recordId = (id) => {
        if (typeof id !== 'string')
            return;
        const match = /^agy_([0-9a-f]+)_/i.exec(id);
        if (match?.[1] !== undefined)
            into.add(match[1].toLowerCase());
    };
    for (const message of messages) {
        if (message.role === 'tool') {
            recordId(message.toolCallId);
        }
        else if (message.role === 'assistant') {
            for (const block of message.content) {
                if (block.type === 'tool-call')
                    recordId(block.id);
            }
        }
    }
}
function snapshotHistory(messages) {
    return messages.map(message => ({
        id: message.id ?? '',
        fingerprint: contentDigest({
            role: message.role,
            content: message.content,
            ...(isRuntimeContextSnapshot(message) ? { runtimeContextSnapshot: true } : {}),
            ...(message.role === 'tool' ? { toolCallId: message.toolCallId, isError: message.isError === true } : {}),
        }),
    }));
}
/** Read a non-empty string field. */
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Extract the structured `(serverName, toolName)` an agent claimed in one
 * permission request: top-level `mcpServerName`/`mcpToolName` or `_meta`.
 * `title` and `rawInput` are deliberately not consulted.
 */
function structuredToolMeta(toolCall) {
    const meta = toolCall?._meta;
    const serverName = nonEmpty(toolCall?.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(toolCall?.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    return {
        ...(serverName !== undefined ? { serverName } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
    };
}
/**
 * Record the structured metadata of one agent-reported tool-call update.
 * The first report establishes the identity; later updates merge only the
 * fields actually present, so a status-only `tool_call_update` never wipes an
 * established `server`/`tool`/`kind`. A later field that contradicts the
 * established identity keeps the original value and marks the record
 * anomalous — the permission gate refuses every further request for that call.
 * @returns 'created' | 'merged' | 'conflict', or undefined for ignored updates.
 */
function recordReportedToolCall(conv, update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
        return;
    if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0)
        return;
    const meta = update._meta;
    const serverName = nonEmpty(update.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(update.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    const kind = typeof update.kind === 'string' ? update.kind : undefined;
    const existing = conv.reportedToolCalls.get(update.toolCallId);
    const merged = existing === undefined ? {} : { ...existing };
    let conflict = false;
    if (kind !== undefined) {
        if (merged.kind !== undefined && merged.kind !== kind)
            conflict = true;
        else
            merged.kind = kind;
    }
    if (serverName !== undefined) {
        if (merged.serverName !== undefined && merged.serverName !== serverName)
            conflict = true;
        else
            merged.serverName = serverName;
    }
    if (toolName !== undefined) {
        if (merged.toolName !== undefined && merged.toolName !== toolName)
            conflict = true;
        else
            merged.toolName = toolName;
    }
    if (conflict)
        merged.conflict = true;
    conv.reportedToolCalls.set(update.toolCallId, merged);
    if (conflict)
        return 'conflict';
    return existing === undefined ? 'created' : 'merged';
}
/** Whether `rawInput` carries no arguments at all (MCP server loading probes). */
function isEmptyInput(rawInput) {
    if (rawInput === undefined || rawInput === null)
        return true;
    if (typeof rawInput === 'string')
        return rawInput.trim().length === 0;
    if (Array.isArray(rawInput))
        return rawInput.length === 0;
    if (typeof rawInput === 'object')
        return Object.keys(rawInput).length === 0;
    return false;
}
/**
 * Append descriptions separately from structural updates. Native routing is
 * always checked against the session's frozen declarations, never the last delta.
 * @param conv - frozen native declarations, Host fingerprints and last delivered descriptions.
 * @param tools - active tools for the current step.
 * @returns informational and/or structural update blocks, or `''` when unchanged.
 */
export function consumeToolDelta(conv, tools) {
    const structural = [];
    const informational = [];
    const nativeTools = new Map((conv.nativeToolBaselines ?? conv.advertisedTools).map(tool => [tool.name, tool]));
    const wireTools = new Map(conv.advertisedTools.map(tool => [tool.name, tool]));
    const active = new Set();
    for (const tool of tools) {
        active.add(tool.name);
        const current = toolState(tool);
        const previous = conv.knownTools.get(tool.name);
        if (previous?.digest === current.digest)
            continue;
        const native = nativeTools.get(tool.name);
        const wire = wireTools.get(tool.name);
        const nativeCompatible = native !== undefined && wire !== undefined && toolState(native).schemaDigest === current.schemaDigest;
        const withinBudget = wire !== undefined && isWithinNativeToolBudget(wire);
        const constraintMatch = conv.numericEnumRules?.has(tool.name)
            ? 'Parameter structure matches your native declaration; the harness enforces the original numeric enums.'
            : 'Parameter constraints match your native declaration.';
        const nativeRoute = nativeCompatible
            ? withinBudget
                ? `${constraintMatch} Use ${AGENT_TOOL_PREFIX}${tool.name} directly.`
                : `Parameter constraints match the original schema. If ${AGENT_TOOL_PREFIX}${tool.name} is present in your direct tool declarations, invoke it directly; otherwise invoke ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}} using the original schema.`
            : undefined;
        const needsCompleteSchema = nativeCompatible && !withinBudget && previous === undefined;
        const action = previous === undefined ? 'restored' : 'updated';
        if (!needsCompleteSchema && (nativeCompatible || previous?.schemaDigest === current.schemaDigest)) {
            const infoTool = conv.numericEnumRules?.has(tool.name) ? lowerNumericEnums(tool)?.tool ?? tool : tool;
            const info = toolState(infoTool);
            conv.knownTools.set(tool.name, { ...current, description: info.description, schemaDescriptions: info.schemaDescriptions });
            const route = nativeRoute
                ?? `Parameter constraints remain as last updated. Continue invoking ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}}.`;
            if (previous === undefined) {
                // Restoration must replace the full set: descriptions from an earlier
                // activation may still exist even though its fingerprint was forgotten.
                informational.push(`[tool ${action}: ${AGENT_TOOL_PREFIX}${tool.name}] ${route} Latest descriptions replace earlier descriptions: ${JSON.stringify({ description: info.description, schemaDescriptions: info.schemaDescriptions })}`);
            }
            else {
                const descriptions = {};
                for (const [path, description] of Object.entries(info.schemaDescriptions)) {
                    if (previous.schemaDescriptions[path] !== description)
                        descriptions[path] = description;
                }
                for (const path of Object.keys(previous.schemaDescriptions)) {
                    if (!(path in info.schemaDescriptions))
                        descriptions[path] = null;
                }
                const patch = {
                    ...previous.description !== info.description ? { description: info.description } : {},
                    ...Object.keys(descriptions).length > 0 ? { schemaDescriptions: descriptions } : {},
                };
                if (Object.keys(patch).length > 0) {
                    informational.push(`[tool ${action}: ${AGENT_TOOL_PREFIX}${tool.name}] ${route} Description patch (omitted fields unchanged; null deletes): ${JSON.stringify(patch)}`);
                }
                else if (previous.schemaDigest !== current.schemaDigest) {
                    informational.push(`[tool ${action}: ${AGENT_TOOL_PREFIX}${tool.name}] ${route}`);
                }
            }
            continue;
        }
        conv.knownTools.set(tool.name, current);
        const schema = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
        if (needsCompleteSchema) {
            structural.push(`[tool ${action}: ${AGENT_TOOL_PREFIX}${tool.name}] ${nativeRoute} Complete original schema: ${schema}`);
        }
        else if (native !== undefined) {
            structural.push(`[tool ${action}: ${AGENT_TOOL_PREFIX}${tool.name}] Invoke ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}} using this latest schema, which supersedes earlier versions: ${schema}`);
        }
        else {
            structural.push(`[tool available via ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}}]: ${schema}`);
        }
    }
    for (const name of [...conv.knownTools.keys()]) {
        if (!active.has(name)) {
            conv.knownTools.delete(name);
            structural.push(`[tool disabled: ${name}]`);
        }
    }
    return [
        informational.length > 0 ? `<harness_tool_info>\n${informational.join('\n')}\n</harness_tool_info>` : '',
        structural.length > 0 ? `<harness_tool_update>\n${structural.join('\n')}\n</harness_tool_update>` : '',
    ].filter(Boolean).join('\n\n');
}
/** Conservative native schema compaction budget; visibility is client-owned. */
export const MAX_EAGER_BRIDGE_TOOL_BYTES = 1_350;
const bridgeToolCache = new WeakMap();
const bridgeToolStateCache = new WeakMap();
function toolState(tool) {
    // Only private immutable snapshots are cached. Caller-owned tool objects
    // passed to consumeToolDelta must be checked again after in-place edits.
    const cached = bridgeToolStateCache.get(tool);
    if (cached !== undefined)
        return cached;
    let hasNonStringEnum = false;
    const schemaDescriptions = {};
    const structure = mapSchemaDescriptions(tool.inputSchema, (description, path) => {
        schemaDescriptions[path] = description;
        return undefined;
    }, '', schema => {
        if (Array.isArray(schema.enum) && schema.enum.some(value => typeof value !== 'string'))
            hasNonStringEnum = true;
    });
    return {
        digest: contentDigest(tool),
        schemaDigest: contentDigest(structure),
        bytes: Buffer.byteLength(JSON.stringify(tool), 'utf8'),
        hasNonStringEnum,
        description: tool.description,
        schemaDescriptions,
    };
}
function isWithinNativeToolBudget(tool) {
    return toolState(tool).bytes <= MAX_EAGER_BRIDGE_TOOL_BYTES;
}
function freezeBridgeTool(tool) {
    freezeTool(tool);
    bridgeToolStateCache.set(tool, toolState(tool));
    return tool;
}
function freezeTool(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freezeTool(child);
        Object.freeze(value);
    }
    return value;
}
function shortenText(text, maxChars) {
    const clean = text.replace(/\s+/gu, ' ').trim();
    if (clean.length <= maxChars)
        return clean;
    const sentenceEnd = clean.indexOf('. ');
    if (sentenceEnd >= 32 && sentenceEnd + 1 <= maxChars)
        return clean.slice(0, sentenceEnd + 1);
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const SCHEMA_KEYWORDS = new Set(['additionalProperties', 'additionalItems', 'contains', 'contentSchema', 'else', 'if', 'items', 'not', 'propertyNames', 'then', 'unevaluatedProperties', 'unevaluatedItems']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Visit only schema locations; property names and enum/const data are opaque. */
function mapSchemaDescriptions(value, transform, path = '', inspect) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value;
    const record = value;
    inspect?.(record, path);
    const entries = [];
    for (const [key, entry] of Object.entries(record)) {
        const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (key === 'description' && typeof entry === 'string') {
            const description = transform(entry, childPath);
            if (description !== undefined)
                entries.push([key, description]);
            continue;
        }
        let mapped = entry;
        if (SCHEMA_MAP_KEYWORDS.has(key) && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            mapped = Object.fromEntries(Object.entries(entry).map(([name, schema]) => [
                name, mapSchemaDescriptions(schema, transform, `${childPath}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, inspect),
            ]));
        }
        else if ((SCHEMA_ARRAY_KEYWORDS.has(key) || key === 'items') && Array.isArray(entry)) {
            mapped = entry.map((schema, index) => mapSchemaDescriptions(schema, transform, `${childPath}/${index}`, inspect));
        }
        else if (SCHEMA_KEYWORDS.has(key)) {
            mapped = mapSchemaDescriptions(entry, transform, childPath, inspect);
        }
        entries.push([key, mapped]);
    }
    return Object.fromEntries(entries);
}
function compactSchemaNode(value, maxDescChars) {
    return mapSchemaDescriptions(value, description => maxDescChars > 0 ? shortenText(description, maxDescChars) : undefined);
}
/** Map simple schema locations to argument locations; ambiguous applicators stay generic. */
function numericEnumPath(schemaPath, schema) {
    const parts = schemaPath.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const path = [];
    let node = schema;
    for (let index = 0; index < parts.length;) {
        if (node === null || typeof node !== 'object' || Array.isArray(node))
            return undefined;
        const parent = node;
        if (parts[index] === 'properties' && parts[index + 1] !== undefined) {
            const key = parts[index + 1];
            path.push(key);
            node = parent.properties[key];
            index += 2;
        }
        else if (parts[index] === 'items') {
            // In draft 2020-12, items excludes the tuple prefix. This checker only
            // supports homogeneous arrays, so leave that whole tool on the generic path.
            if (Array.isArray(parent.prefixItems) && parent.prefixItems.length > 0)
                return undefined;
            path.push(null);
            node = parent.items;
            index++;
        }
        else {
            return undefined;
        }
    }
    return path.length > 0 ? path : undefined;
}
/** Lower only finite numeric enums whose argument location can be checked exactly. */
function lowerNumericEnums(tool) {
    const rules = [];
    let supported = true;
    const schema = mapSchemaDescriptions(structuredClone(tool.inputSchema), description => description, '', (node, schemaPath) => {
        if (!Array.isArray(node.enum) || !node.enum.some(value => typeof value !== 'string'))
            return;
        const path = numericEnumPath(schemaPath, tool.inputSchema);
        const type = node.type;
        if (path === undefined || (type !== 'integer' && type !== 'number')
            || !node.enum.every(value => typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)))) {
            supported = false;
            return;
        }
        const values = [...node.enum];
        rules.push({ path, type, values });
        delete node.enum;
        // Lower after prose compaction so this constraint guidance cannot be truncated.
        node.description = [typeof node.description === 'string' ? node.description : '', `Allowed values: ${JSON.stringify(values)}.`].filter(Boolean).join(' ');
    });
    return supported ? { tool: { ...tool, inputSchema: schema }, rules } : undefined;
}
/** Reject lowered-enum violations before creating a OMP tool call on either MCP path. */
function invalidNumericEnum(rules, args) {
    for (const rule of rules ?? []) {
        const visit = (value, index, location) => {
            if (value === undefined)
                return undefined; // Required fields remain owned by the original OMP schema.
            if (index === rule.path.length) {
                if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value)) || !rule.values.includes(value)) {
                    return `Invalid numeric enum at ${location}: expected ${rule.type} in ${JSON.stringify(rule.values)}.`;
                }
                return undefined;
            }
            const part = rule.path[index];
            if (part === null) {
                // JSON Schema items/properties apply only to matching containers.
                // The original OMP schema owns container types, including nullable ones.
                if (!Array.isArray(value))
                    return undefined;
                for (const [itemIndex, item] of value.entries()) {
                    const error = visit(item, index + 1, `${location}[${itemIndex}]`);
                    if (error !== undefined)
                        return error;
                }
                return undefined;
            }
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                return undefined;
            const key = part;
            if (!Object.hasOwn(value, key))
                return undefined;
            return visit(value[key], index + 1, `${location}.${key}`);
        };
        const error = visit(args, 0, 'arguments');
        if (error !== undefined)
            return error;
    }
    return undefined;
}
/**
 * Reduce MCP tool descriptions toward the conservative native schema budget while
 * preserving every parameter name, type, required list, and enum constraint.
 * Over-budget schemas retain their MCP listing and receive a full fallback schema.
 * Full prose instructions are appended once through the tool information delta.
 * @param tool - raw bridge tool descriptor.
 * @returns compacted descriptor when oversized, otherwise the original descriptor.
 */
export function compactBridgeTool(tool) {
    if (Buffer.byteLength(JSON.stringify(tool), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return tool;
    const pass1 = {
        name: tool.name,
        description: shortenText(tool.description, 220),
        inputSchema: compactSchemaNode(tool.inputSchema, 90),
    };
    if (Buffer.byteLength(JSON.stringify(pass1), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return pass1;
    return {
        name: tool.name,
        description: shortenText(tool.description, 140),
        inputSchema: compactSchemaNode(tool.inputSchema, 0),
    };
}
function toBridgeTools(tools) {
    return (tools ?? []).filter(t => t.deferLoading !== true).map((t) => {
        const signature = contentDigest({ name: t.name, description: t.description, parameters: t.parameters });
        const cached = bridgeToolCache.get(t);
        if (cached?.signature === signature)
            return cached.tool;
        const snapshot = freezeBridgeTool({
            name: t.name,
            description: t.description,
            inputSchema: structuredClone(t.parameters.type === undefined ? { type: 'object', ...t.parameters } : t.parameters),
        });
        bridgeToolCache.set(t, { signature, tool: snapshot });
        return snapshot;
    });
}
async function turnSettled(turn, timeoutMs) {
    const native = turn.nativePrompt;
    if (native === undefined || native.settled)
        return;
    let timer;
    try {
        await Promise.race([native.completion, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Map transport and agent failures onto stable OMP failure codes.
 * @param error - the failure.
 * @returns an LlmError.
 */
export function mapError(error) {
    if (error instanceof LlmError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JsonRpcClosedError)
        return new LlmError(`Antigravity ACP link closed: ${message}`, 'TRANSPORT', { cause: error });
    if (/authentication required|not logged in|unauthenticated|sign in/i.test(message)) {
        return new LlmError(`Antigravity requires sign-in: run \`agy\` once in a terminal (${message})`, 'AUTH', { cause: error });
    }
    if (/quota|resource.?exhausted|limit reached|exceeded your/i.test(message))
        return new LlmError(message, 'QUOTA', { cause: error });
    if (/rate.?limit|429|too many requests|overloaded|capacity/i.test(message))
        return new LlmError(message, 'RATE_LIMIT', { cause: error });
    if (/context|too long|token limit|maximum.*tokens/i.test(message))
        return new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED', { cause: error });
    if (/timeout|timed out|deadline/i.test(message))
        return new LlmError(message, 'TIMEOUT', { cause: error });
    if (error instanceof JsonRpcRemoteError)
        return new LlmError(`Antigravity: ${message}`, 'SERVER', { cause: error });
    return new LlmError(message, 'TRANSPORT', { cause: error });
}
