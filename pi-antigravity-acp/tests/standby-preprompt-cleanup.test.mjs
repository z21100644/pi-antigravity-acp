// A claimed standby remains unused until startPrompt retires its ownership.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AntigravityRuntime } from '../lib/runtime.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { sessionDbPath } from '../lib/usage-db.js'
import { deferred, delay } from '../lib/util.js'

const fixtures = []
after(async () => {
  for (const f of fixtures) { await f.runtime.dispose(); await Promise.all(f.children.map(child => child.done)) }
})
const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result }
const request = extra => ({ provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', sessionId: 'standby',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }], ...extra })
async function until(check) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'Expected adopted-standby cleanup'); await delay(5) }
}
function database(home, id) {
  const path = sessionDbPath(home, id)
  fs.mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path); db.exec('CREATE TABLE steps (idx INTEGER)'); db.close()
  return path
}
async function fixture({ failConfig = false, readImage = async () => undefined } = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), 'omp-standby-preprompt-')), children = [], warnings = []
  const runtime = new AntigravityRuntime({
    config: { ...DEFAULT_CONFIG, home, command: join(import.meta.dirname, 'fake-agy.mjs'), warmup: false, autoPatch: false, maxLiveSessions: 1, patchScript: join(home, 'absent.py') },
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, argv, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_AGY_CONFIG_FAIL: failConfig ? '1' : '' } })
      child.done = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
      })
      children.push(child); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, exited: child.done,
        waitForExit: async () => { await child.done }, terminate: () => child.kill(), stderrTail: () => stderr }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage, canReadImages: () => true, onModelsChanged() {},
    log: { info() {}, warn(message) { warnings.push(message) } },
  })
  const f = { runtime, home, children, warnings, prompts: 0, coldStarts: 0 }; fixtures.push(f)
  await runtime.warmup({ system: '', tools: [], model: 'gemini-4-argon', reasoningEffort: 'medium' })
  runtime.standbyEnabled = false
  const proc = f.proc = await runtime.ensureReady(), entry = f.entry = runtime.standbyPool[0]
  assert.ok(entry)
  f.path = database(home, entry.sessionId); f.legacy = database(home, 'legacy-empty')
  f.marker = join(home, 'agy', 'omp-unused-sessions', `${entry.sessionId}.json`)
  const create = runtime.newTrackedSession.bind(runtime)
  runtime.newTrackedSession = (...args) => { if (args[3] !== true) f.coldStarts++; return create(...args) }
  const prompt = proc.prompt.bind(proc)
  proc.prompt = (id, ...args) => {
    f.prompts++; assert.equal(id, entry.sessionId)
    assert.equal(fs.existsSync(f.marker), false); assert.equal(runtime.unusedSessions.has(id), false)
    return prompt(id, ...args)
  }
  return f
}
function stillOwned(f) {
  assert.equal(fs.existsSync(f.marker), true)
  assert.equal(f.runtime.unusedSessions.get(f.entry.sessionId), f.proc)
}
function reclaimed(f) {
  assert.equal(f.prompts, 0); assert.equal(f.coldStarts, 0, 'the test must exercise a standby hit')
  assert.equal(fs.existsSync(f.path), false); assert.equal(fs.existsSync(f.marker), false)
  assert.equal(f.runtime.unusedSessions.has(f.entry.sessionId), false)
  assert.equal(f.runtime.liveSessionSlots.size, 0); assert.equal(f.runtime.standbyPool.length, 0)
  assert.equal(fs.existsSync(f.legacy), true)
}

test('a standby remains owned during select and retires ownership immediately before its first prompt', async () => {
  const f = await fixture(), select = f.proc.setConfigOption.bind(f.proc)
  let checked = false
  f.proc.setConfigOption = (...args) => { stillOwned(f); checked = true; return select(...args) }
  const chunks = await collect(f.runtime.stream(request()))
  assert.equal(checked, true); assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(f.prompts, 1); assert.equal(f.coldStarts, 0); assert.equal(fs.existsSync(f.path), true)
  await f.runtime.resetSession(f.runtime.conversations.get('standby|main')); await f.runtime.dispose()
  assert.equal(fs.existsSync(f.path), true, 'a submitted session is retained even with synthetic steps = 0')
})

test('an unavailable model after standby claim reclaims its unused DB and capacity', async () => {
  const f = await fixture()
  await assert.rejects(collect(f.runtime.stream(request({ model: 'unavailable-model' }))), /does not offer model/)
  reclaimed(f); assert.equal(f.proc.alive, true)
})

test('a real configuration RPC failure after standby claim reclaims its unused DB', async () => {
  const f = await fixture({ failConfig: true })
  await assert.rejects(collect(f.runtime.stream(request())), /injected configuration failure/)
  reclaimed(f)
})

test('image preparation failure after standby claim resets the session and reclaims its DB', async () => {
  const f = await fixture({ readImage: async () => { stillOwned(f); throw new Error('standby image decode failed') } })
  await assert.rejects(collect(f.runtime.stream(request({ messages: [{ role: 'user', content: [
    { type: 'image', attachment: { attachmentId: 'broken' } },
  ] }] }))), /standby image decode failed/)
  reclaimed(f)
})

test('cancelling after standby model selection reclaims the unsubmitted session', async () => {
  const f = await fixture(), controller = new AbortController(), select = f.proc.setConfigOption.bind(f.proc)
  f.proc.setConfigOption = async (...args) => { stillOwned(f); const value = await select(...args); controller.abort(); return value }
  const chunks = await collect(f.runtime.stream(request({ signal: controller.signal })))
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  await until(() => !fs.existsSync(f.path)); reclaimed(f)
})

test('cancelling image preparation after standby claim reclaims DB, marker and capacity', async () => {
  const entered = deferred(), image = deferred()
  const f = await fixture({ readImage: async () => { stillOwned(f); entered.resolve(); return image.promise } })
  const controller = new AbortController()
  const pending = collect(f.runtime.stream(request({ signal: controller.signal, messages: [{ role: 'user', content: [
    { type: 'image', attachment: { attachmentId: 'image' } },
  ] }] })))
  await entered.promise; controller.abort(); image.resolve({ data: 'aW1n', mimeType: 'image/png' })
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  await until(() => !fs.existsSync(f.path)); reclaimed(f)
})

test('a standby retirement failure at startPrompt prevents submission and cleans the unused session', async () => {
  const f = await fixture(), forget = f.runtime.unusedSessionLedger.forget.bind(f.runtime.unusedSessionLedger)
  let failed = false
  f.runtime.unusedSessionLedger.forget = (id, ...args) => {
    if (id === f.entry.sessionId && !failed) {
      failed = true; throw Object.assign(new Error('standby retirement locked'), { code: 'EPERM' })
    }
    return forget(id, ...args)
  }
  await assert.rejects(collect(f.runtime.stream(request())), /standby retirement locked/)
  reclaimed(f); assert.equal(f.runtime.status().activeTurns, 0)
})

test('a standby without its marker cannot be adopted and drops stale in-memory tracking without deleting its DB', async () => {
  const f = await fixture()
  f.runtime.unusedSessionLedger.forget(f.entry.sessionId)
  assert.equal(f.runtime.unusedSessions.has(f.entry.sessionId), true)
  assert.equal(await f.runtime.takeStandbySession(f.proc, '', []), undefined)
  await until(() => f.runtime.liveSessionSlots.size === 0 && !f.runtime.unusedSessions.has(f.entry.sessionId))
  assert.equal(fs.existsSync(f.path), true); assert.equal(f.entry.boundConversation, undefined)
  assert.ok(f.warnings.some(message => message.includes('could not be verified before adoption')))
  await f.runtime.dispose(); assert.equal(fs.existsSync(f.path), true)
})

test('a foreign standby ownership record prevents adoption and preserves the empty DB', async () => {
  const f = await fixture(), record = JSON.parse(fs.readFileSync(f.marker, 'utf8'))
  record.owner = 'another-owner'; fs.writeFileSync(f.marker, JSON.stringify(record))
  assert.equal(await f.runtime.takeStandbySession(f.proc, '', []), undefined)
  await until(() => f.runtime.liveSessionSlots.size === 0)
  await f.runtime.dispose()
  assert.equal(f.prompts, 0); assert.equal(fs.existsSync(f.path), true)
  assert.equal(JSON.parse(fs.readFileSync(f.marker, 'utf8')).owner, 'another-owner')
})
