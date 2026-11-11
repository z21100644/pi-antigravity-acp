/**
 * Newline-delimited JSON-RPC 2.0 peer over a pair of byte streams. ACP (Agent
 * Client Protocol) v1 frames one JSON message per line on stdio; this peer
 * multiplexes outgoing requests, dispatches incoming requests and
 * notifications, and fails every pending request when the transport closes.
 * @module pi-antigravity-acp/jsonrpc
 */
/** A request the remote peer answered with a JSON-RPC error. */
export class JsonRpcRemoteError extends Error {
    method;
    rpc;
    name = 'JsonRpcRemoteError';
    /**
     * @param method - request method the remote rejected.
     * @param rpc - the remote error object.
     */
    constructor(method, rpc) {
        super(`${method}: ${rpc.message}`);
        this.method = method;
        this.rpc = rpc;
    }
}
/** The transport closed before a pending request settled. */
export class JsonRpcClosedError extends Error {
    name = 'JsonRpcClosedError';
}
/** Bidirectional newline-delimited JSON-RPC 2.0 endpoint. */
export class JsonRpcPeer {
    output;
    handlers;
    nextId = 1;
    pending = new Map();
    buffer = '';
    closed;
    /**
     * @param input - stream carrying frames from the remote peer.
     * @param output - stream carrying frames to the remote peer.
     * @param handlers - incoming message handlers.
     */
    constructor(input, output, handlers) {
        this.output = output;
        this.handlers = handlers;
        input.setEncoding('utf8');
        input.on('data', (chunk) => this.onData(chunk));
        input.on('end', () => this.close(new JsonRpcClosedError('ACP stream ended')));
        input.on('error', (error) => this.close(error));
        output.on('error', (error) => this.close(error));
    }
    /** Whether the transport has closed. */
    get isClosed() {
        return this.closed !== undefined;
    }
    /**
     * Send one request and await its result.
     * @param method - JSON-RPC method.
     * @param params - request parameters.
     * @param options - cancellation and timeout of the wait.
     * @returns the remote result.
     */
    request(method, params, options = {}) {
        if (this.closed !== undefined)
            return Promise.reject(new JsonRpcClosedError(`${method}: transport closed (${this.closed.message})`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                this.pending.delete(id);
                cleanup();
                reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`${method}: aborted`));
            };
            this.pending.set(id, {
                method,
                resolve: (value) => { cleanup(); resolve(value); },
                reject: (error) => { cleanup(); reject(error); },
            });
            if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    cleanup();
                    reject(new Error(`${method}: no response within ${options.timeoutMs}ms`));
                }, options.timeoutMs);
            }
            if (options.signal?.aborted === true) {
                onAbort();
                return;
            }
            options.signal?.addEventListener('abort', onAbort, { once: true });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    /**
     * Send one notification.
     * @param method - JSON-RPC method.
     * @param params - notification parameters.
     */
    notify(method, params) {
        if (this.closed === undefined)
            this.write({ jsonrpc: '2.0', method, params });
    }
    /**
     * Close the peer and fail every pending request.
     * @param error - closure cause reported to pending requests and the close handler.
     */
    close(error) {
        if (this.closed !== undefined)
            return;
        this.closed = error;
        for (const [id, pending] of this.pending) {
            this.pending.delete(id);
            pending.reject(new JsonRpcClosedError(`${pending.method}: ${error.message}`));
        }
        this.handlers.onClose?.(error);
    }
    write(message) {
        try {
            this.output.write(`${JSON.stringify(message)}\n`);
        }
        catch (error) {
            this.close(error instanceof Error ? error : new Error(String(error)));
        }
    }
    onData(chunk) {
        this.buffer += chunk;
        let start = 0;
        let newline = this.buffer.indexOf('\n', start);
        if (newline < 0)
            return;
        while (newline >= 0) {
            const line = this.buffer.slice(start, newline).trim();
            start = newline + 1;
            if (line.length > 0)
                this.onLine(line);
            newline = this.buffer.indexOf('\n', start);
        }
        this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    }
    onLine(line) {
        let message;
        try {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('not an object');
            message = parsed;
        }
        catch (_malformedFrame) {
            // A malformed frame is dropped; the link and in-flight requests stay usable.
            this.handlers.onProtocolError?.(`unparsable frame: ${line.slice(0, 200)}`);
            return;
        }
        const method = typeof message.method === 'string' ? message.method : undefined;
        const id = message.id;
        if (method === undefined) {
            if (typeof id !== 'number') {
                this.handlers.onProtocolError?.(`response without numeric id: ${line.slice(0, 200)}`);
                return;
            }
            const pending = this.pending.get(id);
            if (pending === undefined)
                return;
            const hasResult = Object.hasOwn(message, 'result');
            const hasError = Object.hasOwn(message, 'error');
            if (hasResult === hasError || (hasError && !isRpcError(message.error))) {
                this.handlers.onProtocolError?.(`invalid response for ${pending.method} (id ${id}): expected one result or a structured error`);
                return;
            }
            this.pending.delete(id);
            if (hasError) {
                const rpc = message.error;
                pending.reject(new JsonRpcRemoteError(pending.method, {
                    code: typeof rpc.code === 'number' ? rpc.code : -32603,
                    message: typeof rpc.message === 'string' ? rpc.message : 'unknown error',
                    ...rpc.data === undefined ? {} : { data: rpc.data },
                }));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if (id === undefined || id === null) {
            try {
                this.handlers.onNotification(method, message.params);
            }
            catch (error) {
                this.handlers.onProtocolError?.(`notification handler for ${method} failed: ${String(error)}`);
            }
            return;
        }
        void Promise.resolve()
            .then(() => this.handlers.onRequest(method, message.params))
            .then((result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }), (error) => {
            const rpc = error instanceof JsonRpcRemoteError
                ? error.rpc
                : { code: -32603, message: error instanceof Error ? error.message : String(error) };
            this.write({ jsonrpc: '2.0', id, error: rpc });
        });
    }
}
function isRpcError(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const rpc = value;
    return Number.isInteger(rpc.code) && typeof rpc.message === 'string';
}
