// Retiring native sessions keep capacity; cancellation only removes one waiter.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AntigravityRuntime } from '../lib/runtime.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { deferred, delay } from '../lib/util.js'
import { sessionDbPath } from '../lib/usage-db.js'

const runtimes = [], children = []
after(async () => { for (const runtime of runtimes) await runtime.dispose(); await Promise.all(children) })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5) }
  assert.fail('Expected asynchronous boundary was not reached')
}
async function promptly(promise) {
  return Promise.race([promise, delay(200).then(() => ({ timeout: true }))])
}
const request = extra => ({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'cancelled',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }], ...extra })

async function fixture(maxLiveSessions = 3) {
  const home = mkdtempSync(join(tmpdir(), 'pi-session-recovery-'))
  const log = join(home, 'prompts.jsonl'), warnings = []
  const runtime = new AntigravityRuntime({
    config: { ...DEFAULT_CONFIG, command: join(import.meta.dirname, 'fake-agy.mjs'), home,
      warmup: false, autoPatch: false, patchScript: join(home, 'missing.py'), maxLiveSessions },
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, argv, { cwd, windowsHide: true, env: { ...process.env, FAKE_AGY_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', bytes => { stderr += bytes })
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
      children.push(exited)
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, exited,
        terminate: () => child.kill(), stderrTail: () => stderr }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => undefined, canReadImages: () => false, onModelsChanged() {},
    log: { info() {}, warn(message) { warnings.push(message) } },
  })
  runtimes.push(runtime)
  const proc = await runtime.ensureReady()
  const create = () => runtime.newTrackedSession(proc, { cwd: home, mcpServers: [] }, {})
  return { runtime, proc, create, warnings, home, prompts: () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] }
}

function failClosures(proc, id, count) {
  const original = proc.peer.request.bind(proc.peer), calls = []
  proc.peer.request = (method, params, options) => {
    if (method === 'session/close' && params.sessionId === id) {
      calls.push(performance.now())
      if (calls.length <= count) return Promise.reject(new Error('injected transient close transport failure'))
    }
    return original(method, params, options)
  }
  return calls
}

for (const failed of [1, 2]) {
  test(`native close recovers after ${failed} transient failures with bounded backoff and single-flight callers`, async () => {
    const { runtime, proc, create, warnings } = await fixture()
    const { sessionId } = await create(), slot = [...runtime.liveSessionSlots][0]
    const calls = failClosures(proc, sessionId, failed)
    const first = runtime.closeTrackedSession(proc, sessionId)
    await until(() => calls.length === 1)
    const second = runtime.closeTrackedSession(proc, sessionId)
    await delay(30)
    assert.equal(calls.length, 1)
    assert.equal(runtime.liveSessionSlots.has(slot), true)
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(calls.length, failed + 1)
    assert.ok(calls[1] - calls[0] >= 450)
    if (failed === 2) assert.ok(calls[2] - calls[1] >= 950)
    assert.equal(slot.closing, undefined)
    assert.equal(runtime.liveSessionSlots.size, 0)
    assert.ok(warnings.some(message => message.includes('retrying in 500ms')))
  })
}

test('exhausted close budget stays charged, clears the settled promise, and cannot restart through repeated callers', async () => {
  const { runtime, proc, create, warnings } = await fixture(1)
  const { sessionId } = await create(), slot = [...runtime.liveSessionSlots][0]
  const calls = failClosures(proc, sessionId, Infinity)
  assert.equal(await runtime.closeTrackedSession(proc, sessionId), false)
  assert.equal(calls.length, 3)
  assert.equal(slot.closing, undefined)
  assert.equal(slot.closeAttempts, 3)
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => runtime.closeTrackedSession(proc, sessionId))), Array(5).fill(false))
  assert.equal(calls.length, 3)
  assert.equal(runtime.status().liveSessions, 1)
  await assert.rejects(create(), /CAPACITY_EXCEEDED/)
  assert.ok(warnings.some(message => message.includes('exhausted 3 attempts')))
  proc.stop()
  assert.equal(runtime.liveSessionSlots.size, 1, 'stopping the link does not confirm native exit')
  await proc.exited
  await until(() => runtime.liveSessionSlots.size === 0)
  assert.equal(runtime.liveSessionSlots.size, 0)
})

for (const action of ['dispose', 'process exit']) {
  test(`${action} interrupts close backoff and prevents further retries`, async () => {
    const { runtime, proc, create } = await fixture()
    const { sessionId } = await create()
    const calls = failClosures(proc, sessionId, Infinity)
    const pending = runtime.closeTrackedSession(proc, sessionId)
    await until(() => calls.length === 1)
    const started = performance.now()
    if (action === 'dispose') await runtime.dispose()
    else proc.stop()
    await pending
    assert.ok(performance.now() - started < 200)
    await delay(550)
    assert.equal(calls.length, 1)
    assert.equal(runtime.liveSessionSlots.size, 0)
  })
}

test('a foreground admission waits for retry acknowledgement while the failed close remains charged', async () => {
  const { runtime, proc, create } = await fixture(1)
  const { sessionId } = await create()
  const calls = failClosures(proc, sessionId, 1)
  const closing = runtime.closeTrackedSession(proc, sessionId)
  await until(() => calls.length === 1)
  let admitted = false
  const pending = outcome(create().then(result => { admitted = true; return result }))
  await delay(40)
  assert.equal(admitted, false)
  assert.equal(runtime.liveSessionSlots.size, 1)
  const next = (await pending).value
  await closing
  assert.notEqual(next.sessionId, sessionId)
  assert.equal(calls.length, 2)
  assert.equal(runtime.liveSessionSlots.size, 1)
})

async function pendingWarm(f) {
  const gate = deferred(), entered = deferred(), original = f.proc.newSession.bind(f.proc)
  f.proc.newSession = async (...args) => {
    const result = await original(...args)
    entered.resolve(result)
    await gate.promise
    return result
  }
  const warming = f.runtime.warmup({ system: '', tools: [], model: 'gemini-4-argon' })
  const native = await entered.promise
  return { gate, native, completion: f.runtime.standbyPromise, warming }
}

for (const shell of [false, true]) {
  test(`cancelling a pending warm adoption promptly removes its ${shell ? 'existing' : 'new'} shell and preserves shared warmup`, async () => {
    const f = await fixture(1), { runtime } = f
    const warm = await pendingWarm(f)
    const controller = new AbortController()
    const existing = shell ? runtime.createConversation('cancelled|main', 'main') : undefined
    const pending = outcome(collect(runtime.stream(request({ signal: controller.signal }))))
    await until(() => runtime.conversations.get('cancelled|main')?.opening === true)
    controller.abort()
    const early = await promptly(pending)
    const stillPending = runtime.standbyPromise === warm.completion
    const shells = runtime.conversations.size, occupied = runtime.liveSessionSlots.size
    // Always release real children, including on the unpatched baseline.
    warm.gate.resolve()
    await pending
    await warm.completion
    await warm.warming
    assert.equal(early.value?.at(-1).reason.kind, 'aborted')
    assert.equal(stillPending, true)
    assert.equal(shells, 0)
    assert.equal(occupied, 1)
    if (existing) assert.equal(existing.opening, false)
    assert.equal(f.prompts().length, 0)
    assert.equal((await collect(runtime.stream(request({ sessionId: 'retained' })))).at(-1).reason.kind, 'stop')
    assert.equal(runtime.conversations.get('retained|main').sessionId, warm.native.sessionId)
    assert.equal(runtime.liveSessionSlots.size, 1)
  })
}

test('openSession can cancel its second warmup wait without registering a foreground tenant', async () => {
  const f = await fixture(1), warm = await pendingWarm(f)
  const conv = f.runtime.createConversation('opening|main', 'main'), controller = new AbortController()
  const pending = outcome(f.runtime.openSession(conv, '', [], f.proc, controller.signal))
  await delay(10)
  controller.abort()
  const early = await promptly(pending)
  const tenants = f.runtime.tenants.size
  warm.gate.resolve()
  await pending
  await warm.completion
  await warm.warming
  assert.ok(early.error?.name === 'AbortError')
  assert.equal(conv.sessionId, undefined)
  assert.equal(tenants, 0)
  assert.equal(f.runtime.standbyPool[0].sessionId, warm.native.sessionId)
})

test('a capacity-blocked cold request cancels without cancelling incompatible shared warmup', async () => {
  const f = await fixture(1), warm = await pendingWarm(f), controller = new AbortController()
  const pending = outcome(f.runtime.newTrackedSession(f.proc, { cwd: '.', mcpServers: [] }, {}, false, controller.signal))
  await delay(10)
  controller.abort()
  const early = await promptly(pending)
  warm.gate.resolve()
  await pending
  await warm.completion
  await warm.warming
  assert.ok(early.error?.name === 'AbortError')
  assert.equal(f.runtime.liveSessionSlots.size, 1)
  assert.equal(f.runtime.standbyPool[0].sessionId, warm.native.sessionId)
})

for (const mutex of ['capacityMutex', 'sessionCapacityMutex']) {
  test(`cancellation leaves ${mutex} ownership with its current owner`, async () => {
    const f = await fixture(), controller = new AbortController()
    const key = mutex === 'capacityMutex' ? 'capacity' : 'sessions'
    const release = await f.runtime[mutex].acquire(key)
    const pending = outcome(mutex === 'capacityMutex'
      ? f.runtime.acquireConversation('waiting', 'main', undefined, controller.signal)
      : f.runtime.newTrackedSession(f.proc, {}, {}, false, controller.signal))
    await delay(10)
    controller.abort()
    const early = await promptly(pending)
    let overtook = false
    const successor = f.runtime[mutex].acquire(key).then(unlock => { overtook = true; return unlock })
    await delay(10)
    const beforeRelease = overtook
    release()
    const unlock = await successor; unlock()
    await pending
    assert.ok(early.error?.name === 'AbortError')
    assert.equal(beforeRelease, false)
    assert.equal(f.runtime.conversations.size, 0)
    assert.equal(f.runtime.liveSessionSlots.size, 0)
  })
}

test('cancelling capacity admission leaves native close retries running and charged until acknowledged', async () => {
  const f = await fixture(1), { sessionId } = await f.create(), controller = new AbortController()
  const calls = failClosures(f.proc, sessionId, 1)
  const closing = f.runtime.closeTrackedSession(f.proc, sessionId)
  await until(() => calls.length === 1)
  const pending = outcome(f.runtime.newTrackedSession(f.proc, {}, {}, false, controller.signal))
  await delay(10)
  controller.abort()
  const early = await promptly(pending)
  assert.ok(early.error?.name === 'AbortError')
  assert.equal(f.runtime.liveSessionSlots.size, 1)
  await closing
  assert.equal(calls.length, 2)
  assert.equal(f.runtime.liveSessionSlots.size, 0)
  assert.ok(await f.create())
})

test('one close acknowledgement admits a foreground session without waiting for unrelated closing slots', async () => {
  const f = await fixture(2), a = await f.create(), b = await f.create()
  const gates = new Map([[a.sessionId, deferred()], [b.sessionId, deferred()]])
  const original = f.proc.closeSession.bind(f.proc), entered = new Set()
  f.proc.closeSession = async id => {
    const gate = gates.get(id)
    if (gate) { entered.add(id); await gate.promise }
    return original(id)
  }
  const closing = [f.runtime.closeTrackedSession(f.proc, a.sessionId), f.runtime.closeTrackedSession(f.proc, b.sessionId)]
  await until(() => entered.size === 2)
  const pending = outcome(f.create())
  let early, occupied, unrelatedStillClosing
  try {
    gates.get(a.sessionId).resolve()
    await closing[0]
    early = await promptly(pending)
    occupied = f.runtime.status().liveSessions
    unrelatedStillClosing = [...f.runtime.liveSessionSlots].some(slot => slot.sessionId === b.sessionId && slot.closing !== undefined)
  } finally {
    for (const gate of gates.values()) gate.resolve()
    await Promise.all([...closing, pending])
  }
  assert.ok(early.value?.sessionId, 'one free slot must admit without the second acknowledgement')
  assert.equal(occupied, 2, 'the unrelated closing slot still consumes capacity')
  assert.equal(unrelatedStillClosing, true)
})

test('an already-cancelled admission sends no session/new RPC even with free capacity', async () => {
  const f = await fixture(), controller = new AbortController()
  controller.abort()
  let opens = 0
  const original = f.proc.newSession.bind(f.proc)
  f.proc.newSession = (...args) => { opens++; return original(...args) }
  await assert.rejects(f.runtime.newTrackedSession(f.proc, {}, {}, false, controller.signal), { name: 'AbortError' })
  assert.equal(opens, 0)
  assert.equal(f.runtime.status().liveSessions, 0)
})

test('an unused standby database is retained during close retry and removed only after acknowledgement', async () => {
  const f = await fixture(1)
  await f.runtime.warmup({ system: 'UNUSED_POLICY', tools: [], model: 'gemini-4-argon' })
  const standby = f.runtime.standbyPool[0], path = sessionDbPath(f.home, standby.sessionId)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE steps (idx INTEGER)')
  db.close()
  f.runtime.standbyEnabled = false
  const calls = failClosures(f.proc, standby.sessionId, 1)
  const closing = f.runtime.discardStandby(standby)
  await until(() => calls.length === 1)
  assert.equal(existsSync(path), true)
  assert.equal(f.runtime.status().liveSessions, 1)
  await closing
  assert.equal(calls.length, 2)
  assert.equal(existsSync(path), false)
  assert.equal(f.runtime.status().liveSessions, 0)
})
