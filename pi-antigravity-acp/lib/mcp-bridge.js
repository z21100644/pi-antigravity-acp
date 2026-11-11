/**
 * Loopback Streamable HTTP MCP server that exposes OMP tool schemas to the
 * official Antigravity agent and parks each `tools/call` until OMP has run the
 * tool through its own permission and execution pipeline.
 *
 * Calls answer with a server-sent-event stream so response headers leave
 * immediately; the agent's HTTP client otherwise abandons a request after 60
 * seconds without headers. Comment frames and MCP progress notifications keep
 * long OMP tool runs (approvals, subagents, builds) visibly alive.
 * @module omp-antigravity-acp/mcp-bridge
 */
import { createServer } from 'node:http';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const CONVERSATION_META_KEY = 'antigravity.google/conversation_id';
/** Loopback MCP endpoint shared by every ACP session of one adapter. */
export class McpBridge {
    router;
    options;
    server;
    port = 0;
    openResponses = new Set();
    /** Tenant keys whose agent completed the MCP `initialize` handshake. */
    handshakes = new Set();
    /**
     * @param router - owner routing for listings and calls.
     * @param options - keepalive and logging.
     */
    constructor(router, options) {
        this.router = router;
        this.options = options;
    }
    /** Whether the HTTP listener is bound. */
    get listening() {
        return this.server !== undefined;
    }
    /**
     * Base URL of the endpoint; append `/<tenant>` for a tenant-scoped endpoint.
     * @returns the loopback MCP URL.
     */
    get url() {
        return `http://127.0.0.1:${this.port}/mcp`;
    }
    /** Bind the loopback listener on an ephemeral port. */
    async start() {
        if (this.server !== undefined)
            return;
        const server = createServer((req, res) => { void this.handle(req, res); });
        server.on('connection', socket => socket.setNoDelay(true));
        server.keepAliveTimeout = 0;
        server.requestTimeout = 0;
        server.headersTimeout = 0;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        this.port = server.address().port;
        this.server = server;
    }
    /** Close every open call stream and the listener. */
    async close() {
        const server = this.server;
        this.server = undefined;
        for (const res of this.openResponses)
            res.destroy();
        this.openResponses.clear();
        this.handshakes.clear();
        if (server !== undefined)
            await new Promise(resolve => server.close(() => resolve()));
    }
    /**
     * Whether the agent of one tenant completed the MCP `initialize` handshake,
     * proving it holds this session's bearer credential. This is the explicit
     * evidence a tool-less MCP loading probe must be bound to.
     */
    hasHandshake(tenantKey) {
        return tenantKey !== undefined && this.handshakes.has(tenantKey);
    }
    /** Forget the handshake evidence of one tenant (tenant keys are per session open). */
    forgetTenant(tenantKey) {
        if (tenantKey !== undefined)
            this.handshakes.delete(tenantKey);
    }
    async handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments[0] !== 'mcp' || segments.length > 2) {
            res.writeHead(404).end();
            return;
        }
        // The root path is tenant-less and never exposes tools/list or tools/call.
        const tenantKey = segments.length === 2 && segments[1] !== '' ? segments[1] : undefined;
        if (tenantKey === undefined) {
            res.writeHead(401).end();
            return;
        }
        const authorization = req.headers.authorization;
        const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
        if (!this.router.authorize(tenantKey, bearerToken)) {
            res.writeHead(401).end();
            return;
        }
        if (req.method === 'DELETE') {
            res.writeHead(200).end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST, DELETE' }).end();
            return;
        }
        let body;
        try {
            body = JSON.parse(await readBody(req));
        }
        catch (_invalidJson) {
            // An unparsable body cannot be answered with a request id.
            writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        const messages = Array.isArray(body) ? body : [body];
        const requests = messages.filter((m) => isRecord(m) && typeof m.method === 'string' && m.id !== undefined && m.id !== null);
        if (requests.length === 0) {
            // Notifications and client responses only.
            res.writeHead(202, { 'content-length': 0, connection: 'keep-alive' }).end();
            return;
        }
        const call = requests.find(r => r.method === 'tools/call');
        if (call !== undefined && requests.length === 1) {
            await this.handleCall(res, call, tenantKey);
            return;
        }
        const replies = await Promise.all(requests.map(r => this.answer(r, tenantKey)));
        writeJson(res, 200, Array.isArray(body) ? replies : replies[0]);
    }
    async answer(request, tenantKey) {
        const reply = (result) => ({ jsonrpc: '2.0', id: request.id, result });
        switch (request.method) {
            case 'initialize': {
                const params = isRecord(request.params) ? request.params : {};
                const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
                // The authorized handshake is the only accepted loading-probe evidence.
                if (tenantKey !== undefined)
                    this.handshakes.add(tenantKey);
                return reply({
                    protocolVersion: version,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'omp', version: '0.1.0' },
                    instructions: 'Tools of the Oh My Pi session. Every call is executed by the harness under its own permission policy.',
                });
            }
            case 'ping':
                return reply({});
            case 'tools/list':
                return reply({ tools: this.router.listTools(tenantKey) });
            case 'resources/list':
                return reply({ resources: [] });
            case 'resources/templates/list':
                return reply({ resourceTemplates: [] });
            case 'prompts/list':
                return reply({ prompts: [] });
            case 'tools/call':
                return { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'tools/call must be sent alone' } };
            default:
                return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
        }
    }
    async handleCall(res, request, tenantKey) {
        const params = isRecord(request.params) ? request.params : {};
        if (typeof params.name !== 'string' || params.name.length === 0
            || (params.arguments !== undefined && !isRecord(params.arguments))) {
            writeJson(res, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'tools/call requires a tool name and object arguments.' } });
            return;
        }
        const meta = isRecord(params._meta) ? params._meta : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        const progressToken = meta.progressToken;
        const conversationId = typeof meta[CONVERSATION_META_KEY] === 'string' ? meta[CONVERSATION_META_KEY] : undefined;
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
        });
        res.flushHeaders();
        this.openResponses.add(res);
        const controller = new AbortController();
        let settled = false;
        const onClose = () => {
            this.openResponses.delete(res);
            if (!settled)
                controller.abort(new Error('MCP client closed the tool call'));
        };
        res.on('close', onClose);
        let ticks = 0;
        const keepAlive = setInterval(() => {
            if (res.writableEnded)
                return;
            ticks++;
            res.write(': keepalive\n\n');
            if ((typeof progressToken === 'string' || typeof progressToken === 'number')) {
                writeEvent(res, { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ticks, message: 'Oh My Pi is running the tool' } });
            }
        }, this.options.keepAliveMs);
        let result;
        try {
            result = await this.router.callTool({ tenantKey, conversationId, name, arguments: args, signal: controller.signal });
        }
        catch (error) {
            result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
        finally {
            settled = true;
            clearInterval(keepAlive);
        }
        if (!res.writableEnded && !res.destroyed) {
            writeEvent(res, { jsonrpc: '2.0', id: request.id, result });
            res.end();
            this.options.onResultSent?.(tenantKey, name);
        }
        this.openResponses.delete(res);
        res.off('close', onClose);
        if (controller.signal.aborted)
            this.options.log?.(`mcp: call ${name} finished after the agent disconnected`);
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}
function writeJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'keep-alive' });
    res.end(body);
}
function writeEvent(res, value) {
    res.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}
