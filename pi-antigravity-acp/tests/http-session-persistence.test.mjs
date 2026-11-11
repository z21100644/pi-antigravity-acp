import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBridgeToken, startHttpBridge } from '../http-bridge.js';
import { AntigravityRuntime } from '../lib/runtime.js';

test('HTTP history keeps the final ACP session ID across a complete bridge restart', async t => {
    const userDir = mkdtempSync(join(tmpdir(), 'pi-http-persistence-'));
    const home = join(userDir, 'cache', 'antigravity-acp');
    const fake = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url));
    const log = join(userDir, 'prompts.jsonl');
    writeFileSync(join(userDir, 'antigravity-acp.json'), JSON.stringify({
        command: fake, home, warmup: false, coldSwitchSettleMs: 0, patchScript: join(userDir, 'missing.py'),
    }));
    const ensureReady = AntigravityRuntime.prototype.ensureReady;
    t.mock.method(AntigravityRuntime.prototype, 'ensureReady', async function (...args) {
        // Keep the real HTTP mapping, runtime, and ACP transport; replace only the CLI.
        this.host.spawnAcp = (argv, cwd) => {
            const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, windowsHide: true,
                env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_LOAD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            const closed = new Promise(resolve => child.on('close', resolve));
            return { pid: child.pid, stdin: child.stdin, stdout: child.stdout,
                exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
                terminate: () => child.kill(), waitForExit: () => closed, stderrTail: () => stderr };
        };
        this.host.runCommand = async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' });
        return ensureReady.apply(this, args);
    });
    let bridge = await startHttpBridge({ userDir, port: 0 });
    t.after(async () => { if (bridge) await bridge.close(); });
    const token = ensureBridgeToken(userDir);
    const request = async messages => {
        const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-pi-acp-session-id': 'http-history' },
            body: JSON.stringify({ model: 'gemini-4-argon', reasoning_effort: 'high', messages, tools: [], stream: false }),
        });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result.choices[0].message;
    };
    const index = () => JSON.parse(readFileSync(join(home, 'session-index.json'), 'utf8')).entries['http-history|main'];
    const history = [{ role: 'system', content: 'A history verification.' }, { role: 'user', content: 'remember the marker' }];
    const answer = await request(history);
    const originalId = index().sessionId;
    history.push(answer, { role: 'user', content: 'next after restart' });
    const firstBridge = bridge;
    bridge = undefined;
    await firstBridge.close();
    bridge = await startHttpBridge({ userDir, port: 0 });
    await request(history);
    assert.equal(index().sessionId, originalId, 'loading successfully must not be followed by a new session');
    const prompts = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].session, originalId);
    assert.equal(prompts[1].text, 'next after restart', 'the HTTP assistant message is recognized as this provider\'s own output');
    assert.equal(index().knownHistory.length, 3);
    const records = readFileSync(join(userDir, 'logs', 'antigravity-acp.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.message === `antigravity-acp: restored session ${originalId}`));
});
