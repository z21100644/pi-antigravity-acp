/**
 * One long-lived `agy acp` front process. With `--process-per-session` the
 * front serves every ACP session from an isolated worker, so the main
 * conversation, each subagent, and auxiliary calls run concurrently on one
 * stdio link. This module owns the link, routes per-session notifications,
 * and refuses every agent-to-client capability OMP does not provide.
 * @module omp-antigravity-acp/acp-process
 */
import { JsonRpcPeer, JsonRpcRemoteError } from "./jsonrpc.js";
/** One running `agy acp` front with its initialized link. */
export class AcpProcess {
    options;
    listeners = new Map();
    child;
    peer;
    exitError;
    nativeExit;
    nativeExited = false;
    /** Agent `initialize` result. */
    initializeResult;
    exitListeners = new Set();
    /** @param options - launch parameters. */
    constructor(options) {
        this.options = options;
    }
    /** Whether the process is running with an initialized link. */
    get alive() {
        return this.peer !== undefined && !this.peer.isClosed && this.exitError === undefined;
    }
    /** Link failure does not imply that the native process has exited. */
    get exited() { return this.nativeExit; }
    /** Native exit includes the host's IO/process cleanup confirmation. */
    get hasExited() { return this.nativeExited; }
    get pid() { return this.child?.pid; }
    /**
     * Observe process exit or link closure.
     * @param listener - receives the cause.
     * @returns a disposer.
     */
    onExit(listener) {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }
    /**
     * Spawn the process and complete the ACP `initialize` handshake.
     * @param timeoutMs - handshake deadline.
     */
    async start(timeoutMs) {
        const child = this.options.spawn(this.options.argv, this.options.cwd);
        this.child = child;
        this.nativeExit = child.exited.then(async () => {
            await child.waitForExit?.();
            this.nativeExited = true;
        });
        void this.nativeExit.catch(() => undefined);
        const peer = new JsonRpcPeer(child.stdout, child.stdin, {
            onRequest: (method, params) => this.onRequest(method, params),
            onNotification: (method, params) => this.onNotification(method, params),
            onClose: (error) => this.fail(error),
            onProtocolError: (detail) => this.options.log?.(`acp: dropped frame: ${detail}`),
        });
        this.peer = peer;
        void child.exited.then(({ code, signal }) => {
            const tail = child.stderrTail().trim().split('\n').slice(-5).join(' | ');
            const error = new Error(`agy acp exited (code=${code ?? 'null'} signal=${signal ?? 'null'})${tail ? `: ${tail}` : ''}`);
            peer.close(error);
            this.fail(error);
        });
        this.initializeResult = await peer.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
        }, { timeoutMs });
    }
    /** Terminate the process. */
    stop() {
        const error = new Error('ACP process stopped');
        this.peer?.close(error);
        this.fail(error);
        const child = this.child;
        this.child = undefined;
        child?.terminate();
    }
    /**
     * Create one ACP session.
     * @param params - `session/new` parameters.
     * @param listener - observer bound to the new session id.
     * @param timeoutMs - setup deadline.
     * @returns the session result.
     */
    async newSession(params, listener, timeoutMs) {
        const result = await this.link().request('session/new', params, { timeoutMs });
        this.listeners.set(result.sessionId, listener);
        return result;
    }
    /**
     * Select one configuration option value.
     * @param sessionId - ACP session.
     * @param configId - option id (`model`, `thought_level`).
     * @param value - option value.
     * @returns the complete resulting option list.
     */
    async setConfigOption(sessionId, configId, value) {
        const result = await this.link().request('session/set_config_option', { sessionId, configId, value }, { timeoutMs: 60_000 });
        return result?.configOptions ?? [];
    }
    /**
     * Send one prompt; resolves when the agent ends the turn.
     * @param sessionId - ACP session.
     * @param prompt - prompt content blocks.
     * @returns the prompt result.
     */
    async prompt(sessionId, prompt) {
        return this.link().request('session/prompt', { sessionId, prompt });
    }
    /**
     * Request cancellation of the running turn.
     * @param sessionId - ACP session.
     */
    cancel(sessionId) {
        this.peer?.notify('session/cancel', { sessionId });
    }
    /**
     * Close one session and detach its listener.
     * @param sessionId - ACP session.
     * @returns whether closure was acknowledged or the process is no longer alive.
     */
    async closeSession(sessionId) {
        this.listeners.delete(sessionId);
        if (!this.alive)
            return this.hasExited;
        try {
            await this.link().request('session/close', { sessionId }, { timeoutMs: 15_000 });
            return true;
        }
        catch (error) {
            this.options.log?.(`acp: session/close failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    /**
     * Arbitrary request on the link (diagnostics and discovery).
     * @param method - JSON-RPC method.
     * @param params - parameters.
     * @param timeoutMs - deadline.
     * @returns the result.
     */
    request(method, params, timeoutMs) {
        return this.link().request(method, params, { timeoutMs });
    }
    link() {
        if (this.peer === undefined || this.peer.isClosed || this.exitError !== undefined) {
            throw new Error(`ACP link unavailable${this.exitError ? `: ${this.exitError.message}` : ''}`);
        }
        return this.peer;
    }
    fail(error) {
        if (this.exitError !== undefined)
            return;
        this.exitError = error;
        for (const listener of this.exitListeners)
            listener(error);
    }
    onNotification(method, params) {
        if (method !== 'session/update')
            return;
        const record = params;
        if (record.sessionId === undefined || record.update === undefined)
            return;
        this.listeners.get(record.sessionId)?.onUpdate(record.update);
    }
    onRequest(method, params) {
        if (method === 'session/request_permission') {
            const request = params;
            const outcome = this.listeners.get(request.sessionId)?.onPermission?.(request);
            return { outcome: outcome ?? { outcome: 'cancelled' } };
        }
        // File-system, terminal, and elicitation capabilities are not advertised.
        this.options.log?.(`acp: refused agent request ${method}`);
        throw new JsonRpcRemoteError(method, { code: -32601, message: `${method} is not supported by Oh My Pi` });
    }
}
