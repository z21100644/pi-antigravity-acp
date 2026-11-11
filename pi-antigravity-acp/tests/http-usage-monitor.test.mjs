import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBridgeToken, startHttpBridge } from '../http-bridge.js';
import { AntigravityRuntime } from '../lib/runtime.js';

test('GUI snapshots observe a live stream while OpenAI SSE preserves its standard schema', async t => {
    const userDir = mkdtempSync(join(tmpdir(), 'pi-http-monitor-'));
    writeFileSync(join(userDir, 'antigravity-acp.json'), JSON.stringify({ warmup: false }));
    let streaming, release;
    const active = new Promise(resolve => { streaming = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const sample = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 19 };
    t.mock.method(AntigravityRuntime.prototype, 'stream', async function* () {
        // The HTTP boundary is real; hold generation so a GUI can read between chunks.
        this.quota.read = async () => undefined;
        yield { type: 'text-delta', text: 'live' };
        yield { type: 'usage', usage: sample, exact: true };
        streaming();
        await finish;
        yield { type: 'text-delta', text: ' output' };
        yield { type: 'usage', usage: sample, exact: true };
        yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const bridge = await startHttpBridge({ userDir, port: 0 });
    t.after(() => bridge.close());
    const pending = fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${ensureBridgeToken(userDir)}`, 'content-type': 'application/json',
            'x-pi-acp-session-id': 'visible-session' },
        body: JSON.stringify({ model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'hello' }], tools: [], stream: true,
            stream_options: { include_usage: true } }),
    });
    await active;
    const live = bridge.monitorSnapshot('visible-session');
    assert.equal(live.session.current.status, 'generating');
    assert.equal(live.session.current.estimatedOutputTokens, 1);
    assert.equal(live.session.current.usage.totalTokens, 19);
    assert.equal(bridge.monitorSnapshot('another-session').session, null);
    release();
    const response = await pending, body = await response.text();
    assert.equal(response.status, 200);
    const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(events.pop(), '[DONE]');
    const packets = events.map(line => JSON.parse(line));
    assert.ok(packets.every(packet => packet.object === 'chat.completion.chunk'));
    const final = packets.find(packet => packet.usage);
    assert.equal(final.usage.total_tokens, 38, 'both incremental samples must reach the OpenAI client');
    assert.equal(final.usage.prompt_tokens_details.cached_tokens, 6);
    assert.equal(final.usage.completion_tokens_details.reasoning_tokens, 2);
    const settled = bridge.monitorSnapshot('visible-session');
    assert.equal(settled.session.current.status, 'completed');
    assert.equal(settled.session.current.usage.totalTokens, 38);
    assert.equal(settled.session.current.exact, true);
});
