import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AntigravityRuntime } from './lib/runtime.js'
import { loadConfig } from './lib/settings.js'
import { spawnAcp, runCommand } from './lib/host.js'
import { toMessages } from './lib/messages.js'

export const HTTP_PORT = 32187
export const HTTP_BASE_URL = `http://127.0.0.1:${HTTP_PORT}/v1`
export const BRIDGE_PROVIDER = 'pi-desktop-antigravity-acp'

export function ensureBridgeToken(userDir = join(homedir(), '.pi-desktop')) {
  const folder = join(userDir, 'plugins/data/imported.omp-antigravity-acp')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'bridge-token')
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const token = readFileSync(file, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local ACP bridge token')
  return token
}

function contentBlocks(content) {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw new Error('Invalid message content')
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image_url') {
      const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.image_url?.url ?? '')
      if (!match) throw new Error('The ACP bridge requires embedded image data')
      return { type: 'image', mimeType: match[1], data: match[2] }
    }
    throw new Error(`Unsupported message content: ${part.type}`)
  })
}

export function toAcpRequest(body, headers = {}, signal, fallbackEffort = 'medium') {
  if (typeof body.model !== 'string' || !body.model || !Array.isArray(body.messages))
    throw new Error('model and messages are required')
  const system = [], messages = []
  for (const message of body.messages) {
    const content = contentBlocks(message.content)
    if (message.role === 'system' || message.role === 'developer') {
      system.push(content.map(block => block.text ?? '').join('\n'))
    } else if (message.role === 'assistant') {
      if (message.reasoning_content) content.unshift({ type: 'thinking', thinking: message.reasoning_content })
      for (const call of message.tool_calls ?? []) {
        content.push({ type: 'toolCall', id: call.id, name: call.function.name,
          arguments: JSON.parse(call.function.arguments || '{}') })
      }
      messages.push({ role: 'assistant', provider: BRIDGE_PROVIDER, model: body.model, content })
    } else if (message.role === 'tool') {
      messages.push({ role: 'toolResult', toolCallId: message.tool_call_id, content, isError: false })
    } else if (message.role === 'user') messages.push({ role: 'user', content })
    else throw new Error(`Unsupported message role: ${message.role}`)
  }
  const textOnly = body.tools === undefined || body.tool_choice === 'none'
  const requested = headers['x-pi-acp-reasoning'] ?? body.reasoning_effort
  const reasoningEffort = ['off', 'none', 'minimal', 'low'].includes(requested) ? 'low'
    : ['high', 'xhigh', 'max'].includes(requested) ? 'high' : requested === 'medium' ? 'medium' : fallbackEffort
  return {
    provider: BRIDGE_PROVIDER, model: body.model, system: system.join('\n\n'),
    messages: toMessages(messages), reasoningEffort, purpose: textOnly ? 'text-only' : 'main',
    tools: textOnly ? [] : body.tools.map(tool => {
      if (tool.type !== 'function' || !tool.function?.name) throw new Error('Only function tools are supported')
      return { name: tool.function.name, description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} } }
    }),
    sessionId: headers['x-pi-acp-session-id'] ?? headers['x-session-affinity'] ?? headers['x-session-id'], signal,
  }
}

function wireUsage(usage) {
  const cached = usage.cacheReadTokens ?? 0, written = usage.cacheWriteTokens ?? 0
  const prompt = usage.inputTokens + cached + written
  return { prompt_tokens: prompt, completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    ...(usage.reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}) }
}

async function readBody(req) {
  const chunks = []; let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 64 * 1024 * 1024) throw new Error('ACP request exceeds 64 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startHttpBridge({ userDir = join(homedir(), '.pi-desktop'), port = HTTP_PORT } = {}) {
  // Request history and the runtime must use the same provider identity for reuse.
  const token = ensureBridgeToken(userDir), config = { ...loadConfig(userDir), provider: BRIDGE_PROVIDER }
  mkdirSync(join(userDir, 'logs'), { recursive: true })
  const log = (level, message) => appendFileSync(join(userDir, 'logs/antigravity-acp.log'),
    JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, level, message }) + '\n')
  const runtime = new AntigravityRuntime({
    config, spawnAcp, runCommand,
    readImage: async block => ({ data: block.attachment.data, mimeType: block.attachment.mimeType }),
    canReadImages: () => true,
    log: { info: message => log('debug', message), warn: message => log('warn', message) },
  })
  const controllers = new Set()
  const server = createServer(async (req, res) => {
    const controller = new AbortController()
    controllers.add(controller)
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('PI Desktop disconnected')) })
    let heartbeat
    function json(status, value) {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    function sse(value) {
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
        heartbeat.unref?.()
      }
      res.write(`data: ${JSON.stringify(value)}\n\n`)
    }
    try {
      const auth = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`)
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        json(401, { error: { message: 'Invalid local ACP bridge token', type: 'authentication_error' } }); return
      }
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      if (req.method === 'GET' && path === '/v1/models') {
        json(200, { object: 'list', data: runtime.catalog.list().map(model => ({ id: model.id, object: 'model', owned_by: 'antigravity' })) }); return
      }
      if (req.method !== 'POST' || path !== '/v1/chat/completions') {
        json(404, { error: { message: 'ACP bridge route not found', type: 'invalid_request_error' } }); return
      }
      const body = await readBody(req), request = toAcpRequest(body, req.headers, controller.signal, runtime.defaultEffort())
      log('info', `Local HTTP → ACP: ${request.model}; session ${request.sessionId ?? 'anonymous'}; ${request.tools.length} tools; effort ${request.reasoningEffort}`)
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000)
      const envelope = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created,
        model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let text = '', reasoning = '', usage, finish
      const calls = new Map()
      for await (const chunk of runtime.stream(request)) {
        if (controller.signal.aborted) break
        if (chunk.type === 'text-delta') {
          text += chunk.text
          if (body.stream) sse(envelope({ content: chunk.text }))
        } else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text
          if (body.stream) sse(envelope({ reasoning_content: chunk.text }))
        } else if (chunk.type === 'tool-call-delta') {
          let call = calls.get(chunk.index)
          const first = !call
          if (!call) { call = { index: calls.size, id: chunk.id, type: 'function', function: { name: chunk.name, arguments: '' } }; calls.set(chunk.index, call) }
          call.function.arguments += chunk.argumentsDelta
          if (body.stream) sse(envelope({ tool_calls: [{ index: call.index,
            ...(first ? { id: call.id, type: 'function' } : {}),
            function: { ...(first ? { name: call.function.name } : {}), arguments: chunk.argumentsDelta } }] }))
        } else if (chunk.type === 'usage') usage = wireUsage(chunk.usage)
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (controller.signal.aborted) return
      if (!finish) throw new Error('ACP stream ended without a finish reason')
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const error = new Error(finish.failure.message); error.code = finish.failure.code; throw error
      }
      const reason = finish.kind === 'tool-calls' ? 'tool_calls' : finish.kind === 'max-tokens' ? 'length' : 'stop'
      if (body.stream) {
        sse(envelope({}, reason))
        if (body.stream_options?.include_usage && usage) sse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage })
        res.end('data: [DONE]\n\n')
      } else {
        json(200, { id, object: 'chat.completion', created, model: request.model,
          choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: text || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(calls.size ? { tool_calls: [...calls.values()].map(({ index, ...call }) => call) } : {}) } }], usage })
      }
      log('info', `ACP response complete: ${request.model}; ${reason}`)
    } catch (error) {
      if (!controller.signal.aborted) {
        log('error', `Local ACP request failed: ${String(error?.message ?? error)}`)
        const detail = { message: String(error?.message ?? error), type: 'acp_error', code: error.code ?? 'ACP_ERROR' }
        if (res.headersSent) { sse({ error: detail }); res.end('data: [DONE]\n\n') }
        else json(error.code === 'RATE_LIMIT' ? 429 : error.code === 'AUTH' ? 401 : 502, { error: detail })
      }
    } finally {
      clearInterval(heartbeat)
      controllers.delete(controller)
    }
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  } catch (error) { await runtime.dispose(); throw error }
  log('info', `Local ACP bridge listening on 127.0.0.1:${server.address().port}`)
  return {
    port: server.address().port,
    async close() {
      for (const controller of controllers) controller.abort(new Error('ACP plugin unloaded'))
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await runtime.dispose()
      await closed
    },
  }
}
