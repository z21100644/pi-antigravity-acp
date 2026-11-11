import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityRuntime } from '../lib/runtime.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { loadConfig } from '../lib/settings.js';
import { SessionStore } from '../lib/session-store.js';
import { delay } from '../lib/util.js';

const fake = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url));
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] });
const system = { role: 'system', id: 'sys', content: [{ type: 'text', text: 'You are a test assistant.' }] };
const tool = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
const base = { provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'persistent', tools: [tool] };
const collect = async iterable => { const out = []; for await (const chunk of iterable) out.push(chunk); return out; };
const assistant = (id, chunks) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'antigravity' },
    content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) });
const jsonLines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function makeRuntime(t, { home = mkdtempSync(join(tmpdir(), 'pi-persist-')), env = {}, config = {} } = {}) {
    const suffix = Math.random().toString(16).slice(2), log = join(home, `prompts-${suffix}.jsonl`);
    const mcpLog = join(home, `mcp-${suffix}.jsonl`), eventLog = join(home, `events-${suffix}.jsonl`), warnings = [];
    const runtime = new AntigravityRuntime({
        config: { ...DEFAULT_CONFIG, home, command: fake, warmup: false, coldSwitchSettleMs: 0, ...config },
        spawnAcp: (argv, cwd) => {
            const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, windowsHide: true,
                env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_MCP: mcpLog, FAKE_AGY_EVENTS: eventLog, FAKE_AGY_LOAD: '1', ...env },
                stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            const closed = new Promise(resolve => child.on('close', resolve));
            return { pid: child.pid, stdin: child.stdin, stdout: child.stdout,
                exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
                terminate: () => child.kill(), waitForExit: () => closed, stderrTail: () => stderr };
        },
        runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
        readImage: async () => undefined, canReadImages: () => false,
        log: { info() {}, warn: message => warnings.push(message) },
    });
    t.after(async () => { if (!runtime.disposed) await runtime.dispose(); });
    return { home, runtime, warnings, prompts: () => jsonLines(log), mcps: () => jsonLines(mcpLog), events: () => jsonLines(eventLog),
        index: () => JSON.parse(readFileSync(join(home, 'session-index.json'), 'utf8')).entries };
}
async function firstTurn(t, options) {
    const first = makeRuntime(t, options), history = [system, user('u1', 'first')];
    const chunks = await collect(first.runtime.stream({ ...base, messages: history }));
    return { ...first, history: [...history, assistant('a1', chunks)], sessionId: first.prompts()[0].session };
}

test('a full restart loads the same session, rebinds MCP, ignores replay and retains tracked capacity', async t => {
    const first = await firstTurn(t);
    assert.equal(first.index()['persistent|main'].sessionId, first.sessionId);
    await first.runtime.dispose();
    const second = makeRuntime(t, { home: first.home });
    const chunks = await collect(second.runtime.stream({ ...base, messages: [...first.history, user('u2', 'next')] }));
    assert.equal(second.prompts()[0].session, first.sessionId);
    assert.equal(second.prompts()[0].text, 'next');
    assert.ok(second.mcps().some(event => event.op === 'load'));
    assert.notEqual(second.mcps()[0].authorization, first.mcps()[0].authorization);
    assert.notEqual(second.mcps()[0].url, first.mcps()[0].url);
    assert.ok(!JSON.stringify(chunks).includes('HISTORICAL_REPLAY_MUST_NOT_LEAK'));
    assert.equal(second.runtime.liveSessionSlots.size, 1);
    assert.equal(second.runtime.unusedSessions.has(first.sessionId), false);
});

test('an idle session resumes after capacity eviction', async t => {
    const first = await firstTurn(t, { config: { maxLiveSessions: 1 } });
    await collect(first.runtime.stream({ ...base, sessionId: 'other', messages: [system, user('other', 'other')] }));
    await collect(first.runtime.stream({ ...base, messages: [...first.history, user('u2', 'after eviction')] }));
    assert.equal(first.prompts().at(-1).session, first.sessionId);
    assert.equal(first.prompts().at(-1).text, 'after eviction');
    assert.equal(first.runtime.liveSessionSlots.size, 1);
});

for (const mode of ['rewritten content with the same id', 'compacted history', 'changed system']) {
    test(`restoration rejects ${mode}`, async t => {
        const first = await firstTurn(t);
        await first.runtime.dispose();
        const second = makeRuntime(t, { home: first.home });
        let history = [...first.history, user('u2', 'next')];
        if (mode.startsWith('rewritten')) history[1] = user('u1', 'rewritten');
        if (mode.startsWith('compacted')) history = [system, user('summary', 'compacted'), user('u2', 'next')];
        if (mode.startsWith('changed')) history[0] = { ...system, content: [{ type: 'text', text: 'New system instructions.' }] };
        await collect(second.runtime.stream({ ...base, messages: history }));
        assert.notEqual(second.prompts()[0].session, first.sessionId);
        assert.ok(!second.events().some(event => event.method === 'session/load'));
    });
}

for (const mode of ['unsupported', 'load failure']) {
    test(`${mode} falls back to a new session and releases the failed load slot`, async t => {
        const first = await firstTurn(t);
        await first.runtime.dispose();
        const second = makeRuntime(t, { home: first.home,
            env: mode === 'unsupported' ? { FAKE_AGY_LOAD: '0' } : { FAKE_AGY_LOAD_FAIL: '1' }, config: { maxLiveSessions: 1 } });
        await collect(second.runtime.stream({ ...base, messages: [...first.history, user('u2', 'next')] }));
        assert.notEqual(second.prompts()[0].session, first.sessionId);
        assert.match(second.prompts()[0].text, /<omp_history>/);
        assert.equal(second.runtime.liveSessionSlots.size, 1);
        if (mode === 'load failure') assert.ok(second.warnings.some(message => message.includes('session/load failed')));
    });
}

test('submitting an unfinished prompt removes its durable binding before a crash or cancellation', async t => {
    const first = await firstTurn(t), controller = new AbortController();
    const pending = collect(first.runtime.stream({ ...base, signal: controller.signal,
        messages: [...first.history, user('u2', 'SLEEP 5000')] }));
    for (let i = 0; first.prompts().length < 2 && i < 200; i++) await delay(5);
    assert.equal(first.prompts().length, 2);
    assert.equal(first.index()['persistent|main'], undefined);
    controller.abort();
    assert.equal((await pending).at(-1).reason.kind, 'aborted');
    assert.equal(first.index()['persistent|main'], undefined);
});

test('a corrupt session index is diagnosed and a fresh request remains usable', async t => {
    const home = mkdtempSync(join(tmpdir(), 'pi-corrupt-index-'));
    writeFileSync(join(home, 'session-index.json'), '{broken');
    const f = makeRuntime(t, { home });
    const chunks = await collect(f.runtime.stream({ ...base, messages: [system, user('u1', 'hello')] }));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.ok(f.warnings.some(message => message.includes('session index could not be read')));
});

test('session index writes fail visibly rather than claiming a successful save', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-index-error-')), blocker = join(home, 'file'), warnings = [];
    writeFileSync(blocker, 'a file blocks the parent directory');
    const store = new SessionStore(join(blocker, 'index.json'), message => warnings.push(message));
    assert.equal(store.save('test', {}), false);
    assert.equal(store.get('test'), undefined);
    assert.ok(warnings.some(message => message.includes('could not be written')));
});

test('failure to invalidate a binding prevents a new prompt and leaves no phantom running turn', async t => {
    const first = await firstTurn(t);
    first.runtime.sessions.forget = () => false;
    await assert.rejects(collect(first.runtime.stream({ ...base, messages: [...first.history, user('u2', 'next')] })), /Could not invalidate/);
    assert.equal(first.prompts().length, 1);
    assert.equal(first.runtime.conversations.get('persistent|main').turn, undefined);
    assert.equal(first.runtime.conversations.get('persistent|main').dirty, true);
});

test('model selection serializes dependent changes, rereads options, and retries a rejected value once', async t => {
    const f = makeRuntime(t), conv = f.runtime.createConversation('select|main', 'main');
    const state = { model: 'old', level: 'high' }, calls = [];
    const options = () => [
        { id: 'model', category: 'model', currentValue: state.model, options: [{ value: 'old' }, { value: 'new' }] },
        { id: state.model === 'new' ? 'new-level' : 'old-level', category: 'thought_level', currentValue: state.level },
    ];
    conv.sessionId = 'selection'; conv.model = 'old'; conv.effort = 'high'; conv.configOptions = options();
    f.runtime.catalog.effortsFor = () => ['low', 'high'];
    let active = false;
    const proc = { setConfigOption: async (_session, id, value) => {
        assert.equal(active, false); active = true; calls.push(id);
        await delay(2);
        if (id === 'model' && calls.length > 1) { state.model = value; state.level = 'low'; }
        else if (id !== 'model') state.level = value;
        active = false; return options();
    } };
    assert.equal(await f.runtime.select(conv, proc, 'new', 'high'), true);
    assert.deepEqual(calls, ['model', 'model', 'new-level']);
    assert.equal(state.level, 'high');
    assert.equal(await f.runtime.select(conv, proc, 'new', 'high'), false);
    assert.equal(calls.length, 3);
    conv.model = 'old'; conv.configOptions = [{ id: 'model', currentValue: 'old' }];
    await assert.rejects(f.runtime.select(conv, { setConfigOption: async () => conv.configOptions }, 'new', 'high'), /did not apply/);
});

test('the cold switch waits before prompting and a reused session has no additional settle delay', async t => {
    const f = makeRuntime(t, { config: { coldSwitchSettleMs: 200 } });
    const history = [system, user('u1', 'first')];
    const first = await collect(f.runtime.stream({ ...base, messages: history }));
    const events = f.events(), configAt = events.find(event => event.method === 'session/set_config_option').at;
    assert.ok(events.find(event => event.method === 'session/prompt').at - configAt >= 185);
    await collect(f.runtime.stream({ ...base, reasoningEffort: 'low', messages: [...history, assistant('a1', first), user('u2', 'next')] }));
    const next = f.events().filter(event => ['session/set_config_option', 'session/prompt'].includes(event.method)).slice(-2);
    assert.ok(next[1].at - next[0].at < 185);
});

test('cancelling the cold settle sends no prompt and reclaims the unused session', async t => {
    const f = makeRuntime(t, { config: { coldSwitchSettleMs: 1000 } }), controller = new AbortController();
    const pending = collect(f.runtime.stream({ ...base, signal: controller.signal, messages: [system, user('u1', 'cancel')] }));
    for (let i = 0; !f.events().some(event => event.method === 'session/set_config_option') && i < 200; i++) await delay(5);
    await delay(30); controller.abort();
    assert.equal((await pending).at(-1).reason.kind, 'aborted');
    assert.equal(f.prompts().length, 0);
    for (let i = 0; f.runtime.liveSessionSlots.size > 0 && i < 100; i++) await delay(5);
    assert.equal(f.runtime.liveSessionSlots.size, 0);
});

test('cold switch config accepts 0..2000 and rejects invalid values', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-settings-'));
    assert.equal(loadConfig(home).coldSwitchSettleMs, 80);
    for (const value of [0, 2000]) {
        writeFileSync(join(home, 'antigravity-acp.json'), JSON.stringify({ coldSwitchSettleMs: value }));
        assert.equal(loadConfig(home).coldSwitchSettleMs, value);
    }
    for (const value of [-1, 2001, 0.5, '80']) {
        writeFileSync(join(home, 'antigravity-acp.json'), JSON.stringify({ coldSwitchSettleMs: value }));
        assert.throws(() => loadConfig(home), /coldSwitchSettleMs/);
    }
});
