// Regressions for cancellation and unload races at asynchronous boundaries.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { AcpProcess } from '../lib/acp-process.js'
import { AntigravityRuntime } from '../lib/runtime.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { deferred, delay, KeyedMutex } from '../lib/util.js'

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-agy.mjs')
const runtimes = []
after(async () => { for (const runtime of runtimes) await runtime.dispose() })

function fixture(overrides = {}, configOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pi-lifecycle-'))
  const log = join(home, 'prompts.jsonl')
  let spawned = 0
  const runtime = new AntigravityRuntime({
    config: { ...DEFAULT_CONFIG, command: fake, home, patchScript: join(home, 'missing.py'), warmup: false, ...configOverrides },
    spawnAcp: (argv, cwd) => {
      spawned++
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd, env: { ...process.env, FAKE_AGY_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout,
        exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(), stderrTail: () => '' }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true, log: { info() {}, warn() {} }, ...overrides,
  })
  runtimes.push(runtime)
  return { runtime, spawned: () => spawned, prompts: () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
}

const request = (extra = {}) => ({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'main',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }], ...extra })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))

function pausedChild() {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const initialized = deferred(), exited = deferred()
  let terminated = 0
  stdin.on('data', bytes => {
    const message = JSON.parse(bytes.toString())
    if (message.method === 'initialize') initialized.resolve(message.id)
  })
  return { initialized, terminated: () => terminated, stdout,
    child: { stdin, stdout, exited: exited.promise, stderrTail: () => '', terminate: () => { terminated++ } },
    finish() { stdout.end(); exited.resolve({ code: 0, signal: null }) } }
}

test('unloading during preflight never starts ACP or reopens the MCP listener', async () => {
  const entered = deferred(), version = deferred()
  const f = fixture({ runCommand: async argv => {
    if (argv.includes('--version')) { entered.resolve(); return version.promise }
    return { code: 0, stdout: '{}', stderr: '' }
  } })
  const starting = outcome(f.runtime.ensureReady())
  await entered.promise
  await f.runtime.dispose()
  version.resolve({ code: 0, stdout: 'fake-agy 0.0.1', stderr: '' })
  const result = await starting
  const leaked = { spawned: f.spawned(), listening: f.runtime.bridge.listening, state: f.runtime.status().state }
  await f.runtime.dispose()
  assert.match(result.error?.message ?? '', /disposed/)
  assert.deepEqual(leaked, { spawned: 0, listening: false, state: 'idle' })
})

test('unloading during initialize terminates the starting child and rejects readiness promptly', async () => {
  const child = pausedChild()
  const { runtime } = fixture({ spawnAcp: () => child.child })
  const starting = outcome(runtime.ensureReady())
  const id = await child.initialized.promise
  const disposing = runtime.dispose()
  const stopped = child.terminated()
  const result = await Promise.race([starting, delay(80).then(() => ({ timeout: true }))])
  // Release both old and fixed implementations even when an assertion fails.
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } })}\n`)
  child.finish()
  await disposing
  await starting
  await runtime.dispose()
  assert.equal(stopped, 1)
  assert.ok(result.error, 'readiness must reject without waiting for child exit or handshake timeout')
  assert.equal(runtime.bridge.listening, false)
  assert.notEqual(runtime.status().state, 'ready')
})

test('failed initialize terminates its child and closes the MCP listener', async () => {
  const child = pausedChild()
  const { runtime } = fixture({ spawnAcp: () => child.child })
  const starting = outcome(runtime.ensureReady())
  const id = await child.initialized.promise
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'handshake rejected' } })}\n`)
  const result = await starting
  const stopped = child.terminated(), listening = runtime.bridge.listening
  child.finish()
  await runtime.dispose()
  assert.match(result.error?.message ?? '', /handshake rejected/)
  assert.equal(stopped, 1)
  assert.equal(listening, false)
})

test('stopping ACP rejects pending RPCs before the operating system reports exit', async () => {
  const child = pausedChild()
  const proc = new AcpProcess({ argv: ['fake'], cwd: '.', spawn: () => child.child, clientName: 'test', clientVersion: '1' })
  const starting = outcome(proc.start(1000))
  await child.initialized.promise
  proc.stop()
  proc.stop() // Repeated unload paths must not terminate the same child twice.
  const result = await Promise.race([starting, delay(80).then(() => ({ timeout: true }))])
  child.finish()
  await starting
  assert.match(result.error?.message ?? '', /stopped/)
  assert.equal(child.terminated(), 1)
})

test('an unavailable native prompt rejects asynchronously under its Promise contract', async () => {
  const proc = new AcpProcess({ argv: ['fake'], cwd: '.', spawn: () => { throw new Error('must not spawn') },
    clientName: 'test', clientVersion: '1' })
  let pending
  assert.doesNotThrow(() => { pending = proc.prompt('missing', []) })
  await assert.rejects(pending, /ACP link unavailable/)
})

test('a cancelled queued request finishes before the current request releases its lock', async () => {
  const { runtime, prompts } = fixture()
  await runtime.ensureReady()
  const release = await runtime.mutex.acquire('main|main')
  const controller = new AbortController()
  const pending = outcome(collect(runtime.stream(request({ signal: controller.signal }))))
  await delay(10)
  controller.abort()
  const result = await Promise.race([pending, delay(100).then(() => ({ timeout: true }))])
  release()
  await pending
  assert.equal(result.value?.at(-1).reason.kind, 'aborted')
  assert.equal(prompts().length, 0, 'a cancelled waiter must never send a model prompt')
  assert.equal(runtime.conversations.size, 0)
})

test('cancelling a startup waiter returns promptly while another request completes shared startup', async () => {
  const entered = deferred(), version = deferred()
  const f = fixture({ runCommand: async argv => {
    if (argv.includes('--version')) { entered.resolve(); return version.promise }
    return { code: 0, stdout: '{}', stderr: '' }
  } })
  const controller = new AbortController()
  const cancelled = collect(f.runtime.stream(request({ signal: controller.signal })))
  await entered.promise
  const retained = collect(f.runtime.stream(request({ sessionId: 'other' })))
  controller.abort()
  const result = await Promise.race([cancelled, delay(100).then(() => [])])
  version.resolve({ code: 0, stdout: 'fake-agy 0.0.1', stderr: '' })
  const [aborted, completed] = await Promise.all([cancelled, retained])
  assert.equal(result.at(-1)?.reason.kind, 'aborted')
  assert.equal(aborted.at(-1).reason.kind, 'aborted')
  assert.equal(completed.at(-1).reason.kind, 'stop')
  assert.equal(f.spawned(), 1)
  assert.equal(f.prompts().length, 1)
})

test('cancellation while preparing images does not send the prepared prompt', async () => {
  const entered = deferred(), image = deferred()
  const { runtime, prompts } = fixture({ readImage: async () => { entered.resolve(); return image.promise } })
  const controller = new AbortController()
  const pending = collect(runtime.stream(request({ signal: controller.signal, messages: [{ role: 'user', content: [
    { type: 'image', attachment: { attachmentId: 'image' } },
  ] }] })))
  await entered.promise
  controller.abort()
  image.resolve({ data: 'aW1n', mimeType: 'image/png' })
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(prompts().length, 0)
  assert.equal(runtime.status().activeTurns, 0)
})

test('cancelling tool-image preparation keeps the parked result retryable in the same ACP turn', async () => {
  const entered = deferred(), image = deferred()
  let reads = 0
  const { runtime, prompts } = fixture({ readImage: async () => {
    if (++reads === 1) { entered.resolve(); return image.promise }
    return { data: 'aW1n', mimeType: 'image/png' }
  } })
  const firstRequest = request({ tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'CALL read {}' }] }] })
  const first = await collect(runtime.stream(firstRequest))
  const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  const conv = runtime.conversations.get('main|main'), sessionId = conv.sessionId
  const controller = new AbortController()
  const resume = { ...firstRequest, messages: [...firstRequest.messages,
    { role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' },
      content: first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'image', attachment: { attachmentId: 'result' } }] },
  ] }
  const pending = collect(runtime.stream({ ...resume, signal: controller.signal }))
  await entered.promise
  controller.abort()
  image.resolve({ data: 'aW1n', mimeType: 'image/png' })
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  assert.equal(conv.turn.pendingCalls.size, 1)
  const completed = await collect(runtime.stream(resume))
  assert.equal(completed.at(-1).reason.kind, 'stop')
  assert.equal(conv.sessionId, sessionId)
  assert.equal(prompts().length, 1)
  assert.match(completed.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /RESULT\(read\)=\[image\]/)
})

test('cancelling a mutex waiter preserves FIFO exclusion for its successor', async () => {
  const mutex = new KeyedMutex(), controller = new AbortController()
  const releaseFirst = await mutex.acquire('same')
  const cancelled = outcome(mutex.acquire('same', controller.signal))
  let acquired = false
  const last = mutex.acquire('same').then(release => { acquired = true; return release })
  controller.abort(new Error('cancel waiter'))
  const result = await Promise.race([cancelled, delay(80).then(() => ({ timeout: true }))])
  await delay(5)
  const overtook = acquired
  releaseFirst()
  const old = await cancelled
  old.value?.()
  const releaseLast = await last
  releaseLast()
  assert.match(result.error?.message ?? '', /cancel waiter/)
  assert.equal(overtook, false)
  assert.equal(mutex.tails.size, 0)
})

test('cancellation observes native completion behind buffered output without the five-second timeout', async () => {
  const { runtime, prompts } = fixture()
  const proc = await runtime.ensureReady()
  const original = proc.prompt.bind(proc), completed = deferred()
  proc.prompt = (...args) => {
    const result = original(...args)
    void result.then(completed.resolve, completed.reject)
    return result
  }
  const controller = new AbortController()
  const iterator = runtime.stream(request({ signal: controller.signal }))
  assert.equal((await iterator.next()).value.type, 'block-start')
  await completed.promise
  const conv = runtime.conversations.get('main|main')
  assert.equal(conv.turn.events.peek().kind, 'text')
  controller.abort()
  const start = performance.now()
  const chunks = await collect(iterator)
  const elapsed = performance.now() - start
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.ok(elapsed < 500, `completion was already acknowledged, but cancellation took ${elapsed}ms`)
  await collect(runtime.stream(request()))
  assert.notEqual(prompts()[1].session, prompts()[0].session)
})

for (const duringImageRead of [false, true]) {
  test(`tool results restart an ended native prompt ${duringImageRead ? 'when it ends during image preparation' : 'when completion is behind buffered text'}`, async () => {
    const entered = deferred(), image = deferred(), completed = deferred()
    const { runtime, prompts } = fixture({ readImage: async () => { entered.resolve(); return image.promise } }, { parkSettleMs: 10 })
    const proc = await runtime.ensureReady(), original = proc.prompt.bind(proc)
    let nativeCompleted = false
    proc.prompt = (...args) => {
      const result = original(...args)
      void result.then(value => { nativeCompleted = true; completed.resolve(value) }, completed.reject)
      return result
    }
    const firstRequest = request({ tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'CALL_AND_END read {}' }] }] })
    const first = await collect(runtime.stream(firstRequest))
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    const conv = runtime.conversations.get('main|main'), oldTurn = conv.turn, oldCall = oldTurn.calls.get(call.id)
    const content = duringImageRead
      ? [{ type: 'text', text: 'LATE_RESULT' }, { type: 'image', attachment: { attachmentId: 'late-image' } }]
      : [{ type: 'text', text: 'LATE_RESULT' }]
    const resume = { ...firstRequest, messages: [...firstRequest.messages,
      { role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' },
        content: first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) },
      { role: 'tool', toolCallId: call.id, content },
    ] }
    if (!duringImageRead) await completed.promise
    const resumed = collect(runtime.stream(resume))
    if (duringImageRead) {
      await entered.promise
      assert.equal(nativeCompleted, false, 'the native prompt must still be running when image preparation begins')
      await completed.promise
      image.resolve({ data: 'aW1n', mimeType: 'image/png' })
    }
    assert.equal((await resumed).at(-1).reason.kind, 'stop')
    assert.equal(prompts().length, 2, 'late tool results require a new native prompt')
    assert.match(prompts()[1].text, /LATE_RESULT/)
    assert.equal(oldCall.result.settled, true, 'retired MCP calls must not stay parked')
    if (duringImageRead) assert.equal(prompts()[1].images, 1, 'late image results must reach the new prompt')
  })
}

test('a failed native prompt preserves its original error when tool results arrive later', async () => {
  const { runtime, prompts } = fixture({}, { parkSettleMs: 10 })
  const proc = await runtime.ensureReady(), original = proc.prompt.bind(proc), completed = deferred()
  proc.prompt = (...args) => {
    const result = original(...args)
    void result.then(completed.resolve, error => completed.resolve(error))
    return result
  }
  const firstRequest = request({ tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'CALL_AND_FAIL read {}' }] }] })
  const first = await collect(runtime.stream(firstRequest))
  const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  const oldCall = runtime.conversations.get('main|main').turn.calls.get(call.id)
  assert.match((await completed.promise).message, /NATIVE_TOOL_TURN_FAILURE/)
  const resumed = request({ tools: firstRequest.tools, messages: [...firstRequest.messages,
    { role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' },
      content: first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'LATE_RESULT' }] },
  ] })
  await assert.rejects(collect(runtime.stream(resumed)), /NATIVE_TOOL_TURN_FAILURE/)
  assert.equal(prompts().length, 1, 'do not retry a failed native prompt as a successful tool continuation')
  assert.equal(oldCall.result.settled, true)
  assert.equal(runtime.status().activeTurns, 0)
})
