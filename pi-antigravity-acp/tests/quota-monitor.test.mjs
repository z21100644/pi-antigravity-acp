import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaReader, parseUsage } from '../lib/quota.js';
import { UsageMonitor } from '../lib/usage-monitor.js';
import { runCommand } from '../lib/host.js';
import { number, percent, wholePercent, resetTime, selectedGroup } from '../renderer/format.mjs';

const rawGroups = [{ name: 'Gemini Models', buckets: [
    { id: 'gemini-5h', name: 'Five hours', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T05:00:00Z' },
    { id: 'gemini-week', name: 'Weekly', window: 'weekly', remaining_fraction: 0.45, reset_time: '2030-01-07T00:00:00Z' },
] }, { name: 'Claude and GPT Models', buckets: [
    { id: 'claude-5h', window: '5h', remaining_fraction: 1, reset_time: '2030-01-01T05:00:00Z' },
] }];
const stdout = JSON.stringify({ command: { data: { groups: rawGroups } } });
const result = { code: 0, stdout, stderr: '' };
const usage = (input, output) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 3,
    cacheWriteTokens: 2, totalTokens: input + output + 5 });
function quotaFixture(t, options = {}) {
    let now = Date.parse('2030-01-01T00:00:00Z');
    const calls = [], warnings = [];
    const quota = new QuotaReader(() => 'test-agy', async (...args) => { calls.push(args); return result; }, 120_000,
        { now: () => now, warn: message => warnings.push(message), ...options });
    t.after(() => quota.dispose());
    return { quota, calls, warnings, advance: ms => { now += ms; } };
}

test('official quota parsing preserves zero and rejects missing or invalid fractions', () => {
    const sample = structuredClone(rawGroups);
    sample[0].buckets[0].remaining_fraction = 0;
    assert.equal(parseUsage(JSON.stringify({ command: { data: { groups: sample } } }))[0].buckets[0].remainingFraction, 0);
    for (const fraction of [undefined, null, '0.5', -0.1, 1.1]) {
        sample[0].buckets[0].remaining_fraction = fraction;
        assert.throws(() => parseUsage(JSON.stringify({ command: { data: { groups: sample } } })), /Invalid quota fraction/);
    }
    assert.throws(() => parseUsage('{}'), /no quota groups/);
});

test('quota polling, manual refresh and completion share a throttle and an inflight command', async t => {
    const { quota, calls, advance } = quotaFixture(t);
    let complete;
    quota.run = (...args) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); };
    const first = quota.read(), second = quota.read(true);
    assert.equal(calls.length, 1);
    assert.equal(quota.snapshot().refreshing, true);
    assert.deepEqual(calls[0][0], ['test-agy', '-p', '/usage', '--output-format', 'json']);
    complete(result);
    await Promise.all([first, second]);
    assert.equal(quota.snapshot().refreshing, false);
    await quota.read(true);
    assert.equal(calls.length, 1);
    advance(15_000);
    quota.run = async (...args) => { calls.push(args); return result; };
    await quota.read();
    assert.equal(calls.length, 1, 'a local UI poll uses the 120s cache');
    await quota.read(true);
    assert.equal(calls.length, 2);
    assert.equal(quota.snapshot().stale, false);
});

test('quota cache survives restart; errors retain the original snapshot time and values', async t => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'pi-quota-')), 'quota-cache.json');
    const first = quotaFixture(t, { cachePath });
    await first.quota.read();
    const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(saved.version, 1);
    const restored = quotaFixture(t, { cachePath });
    await restored.quota.read();
    assert.equal(restored.calls.length, 0);
    assert.deepEqual(restored.quota.snapshot().groups, first.quota.snapshot().groups);
    restored.advance(120_001);
    restored.quota.run = async () => ({ code: 7, stdout: '', stderr: 'official quota temporarily unavailable' });
    await restored.quota.read();
    const failed = restored.quota.snapshot();
    assert.equal(failed.status, 'error');
    assert.equal(failed.stale, true);
    assert.equal(failed.updatedAt, saved.updatedAt, 'a failed attempt must not make the old quota look fresh');
    assert.equal(failed.groups[0].buckets[0].remainingFraction, 0.75);
    assert.match(failed.error, /exited 7/);
    assert.equal(restored.warnings.length, 1);
});

test('corrupt quota caches and unresolved binaries are visible failures, not zero balances', async t => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'pi-quota-')), 'quota-cache.json');
    writeFileSync(cachePath, '{broken');
    const { quota, warnings } = quotaFixture(t, { cachePath });
    quota.binary = () => { throw new Error('agy not installed'); };
    await quota.read();
    assert.equal(quota.snapshot().updatedAt, null);
    assert.deepEqual(quota.snapshot().groups, []);
    assert.match(quota.snapshot().error, /not installed/);
    assert.equal(warnings.length, 2);
});

test('disposing the quota reader cancels its helper command without publishing fresh data', async t => {
    const { quota, calls, warnings } = quotaFixture(t);
    let signal;
    quota.run = async (_argv, _timeout, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const pending = quota.read();
    quota.dispose();
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(quota.snapshot().updatedAt, null);
    await quota.read(true);
    assert.equal(calls.length, 0);
    assert.equal(warnings.length, 0);
});

test('monitor streams estimates separately from incremental billed usage and official quota', t => {
    const { quota } = quotaFixture(t);
    quota.read = async () => undefined;
    const monitor = new UsageMonitor(quota);
    t.after(() => monitor.dispose());
    monitor.begin('request', { purpose: 'main', sessionId: 'one', model: 'gemini-4-carbon' });
    monitor.chunk('request', { type: 'text-delta', text: 'abcd中文' });
    monitor.chunk('request', { type: 'reasoning-delta', text: 'efgh' });
    let view = monitor.snapshot('one');
    assert.equal(view.session.current.estimatedOutputTokens, 4);
    assert.equal(view.session.current.outputCharacters, 10);
    assert.equal(view.session.totals.totalTokens, 0);
    assert.deepEqual(view.quota.groups, [], 'output estimates cannot fabricate subscription fractions');
    monitor.chunk('request', { type: 'usage', usage: usage(10, 5), exact: true });
    monitor.chunk('request', { type: 'usage', usage: usage(20, 8), exact: true });
    monitor.chunk('request', { type: 'finish', reason: { kind: 'tool-calls' } });
    monitor.end('request');
    view = monitor.snapshot('one');
    assert.equal(view.session.current.status, 'waiting_tools');
    assert.equal(view.session.current.usage.totalTokens, 53);
    assert.equal(view.session.totals.totalTokens, 53);
    assert.equal(view.session.current.exact, true);
    view.session.totals.totalTokens = -1;
    assert.equal(monitor.snapshot('one').session.totals.totalTokens, 53, 'the UI cannot mutate the ledger');
    monitor.begin('next', { purpose: 'main', sessionId: 'one', model: 'gemini-4-carbon' });
    monitor.chunk('next', { type: 'usage', usage: usage(4, 2), exact: false });
    monitor.chunk('next', { type: 'finish', reason: { kind: 'stop' } });
    monitor.end('next');
    view = monitor.snapshot('one');
    assert.equal(view.session.totals.totalTokens, 64);
    assert.equal(view.session.current.exact, false);
    assert.equal(view.session.current.status, 'completed');
});

test('monitor isolates selected conversations, excludes title requests and records cancellation', t => {
    const { quota } = quotaFixture(t);
    quota.read = async () => undefined;
    const monitor = new UsageMonitor(quota);
    t.after(() => monitor.dispose());
    monitor.begin('title', { purpose: 'text-only', sessionId: 'one' });
    monitor.chunk('title', { type: 'usage', usage: usage(1000, 1000) });
    assert.equal(monitor.snapshot('one').session, null);
    monitor.begin('r1', { purpose: 'main', sessionId: 'one', model: 'gemini-4-carbon' });
    monitor.begin('r2', { purpose: 'main', sessionId: 'two', model: 'claude-opus-5-5' });
    monitor.end('r1', 'aborted');
    monitor.end('r2');
    assert.equal(monitor.snapshot('one').session.current.status, 'aborted');
    assert.equal(monitor.snapshot('two').session.current.status, 'error');
    assert.equal(monitor.snapshot(null).session, null);
});

test('tool rounds schedule one completion refresh and unloading removes pending work', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { quota } = quotaFixture(t);
    let calls = 0, now = quota.now();
    quota.lastAttemptAt = now;
    quota.read = async force => { assert.equal(force, true); calls++; };
    const monitor = new UsageMonitor(quota, { now: () => now });
    t.after(() => monitor.dispose());
    for (const id of ['a', 'b', 'c']) {
        monitor.begin(id, { purpose: 'main', sessionId: 'one' });
        monitor.end(id);
    }
    t.mock.timers.tick(14_999);
    assert.equal(calls, 0);
    now += 15_000;
    t.mock.timers.tick(1);
    assert.equal(calls, 1);
    monitor.begin('last', { purpose: 'main', sessionId: 'one' });
    monitor.end('last');
    monitor.dispose();
    t.mock.timers.tick(60_000);
    assert.equal(calls, 1);
    monitor.begin('unloaded', { purpose: 'main', sessionId: 'two' });
    assert.equal(monitor.requests.size, 0);
});

test('GUI formats actual zero quota and keeps unknown balances and dates unavailable', () => {
    assert.equal(percent(0), '0%');
    assert.equal(percent(0.754), '75.4%');
    assert.equal(wholePercent(0.958), '95%');
    assert.equal(wholePercent(0.29), '29%');
    assert.equal(wholePercent(0), '0%');
    assert.equal(wholePercent(1), '100%');
    for (const value of [null, undefined, NaN, -1, 2]) {
        assert.equal(percent(value), '—');
        assert.equal(wholePercent(value), '—');
    }
    assert.equal(number(undefined, 'en'), '—');
    assert.equal(resetTime(null, 'en'), '—');
    assert.equal(resetTime('invalid', 'en'), '—');
    const groups = parseUsage(stdout);
    assert.equal(selectedGroup(groups, 'claude-opus-5-5').name, 'Claude and GPT Models');
    assert.equal(selectedGroup(groups, 'gemini-4-carbon').name, 'Gemini Models');
});

test('helper command runner observes cancellation before and after spawning', async () => {
    const cancelled = AbortSignal.abort(new Error('cancel before spawn'));
    assert.throws(() => runCommand([process.execPath, '-e', 'process.exit(99)'], 5000, { signal: cancelled }), /cancel before spawn/);
    const controller = new AbortController();
    const pending = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], 5000, { signal: controller.signal });
    controller.abort(new Error('cancel running helper'));
    await assert.rejects(pending, /cancel running helper/);
});
