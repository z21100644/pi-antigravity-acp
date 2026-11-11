import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeGenMetadata, SessionUsageReader } from '../lib/usage-db.js';
import { AcpTurn, pumpStep } from '../lib/conversation.js';

function varint(value) {
    const bytes = [];
    do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
}
const field = (id, bytes) => Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
const count = (id, value) => Buffer.concat([varint(id * 8), varint(value)]);
const stats = (input = 100, output = 10, cache = 20) => Buffer.concat([count(2, input), count(3, output), count(5, cache), count(9, 3)]);
const generation = usage => field(1, field(4, usage));
function fixture(t, gen = true) {
    const path = join(mkdtempSync(join(tmpdir(), 'pi-usage-')), 'usage.db');
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)');
    if (gen) db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    return { db, path,
        step: (idx, usage, status = 3) => db.prepare('INSERT OR REPLACE INTO steps VALUES (?,15,?,?)').run(idx, status, field(9, usage)),
        gen: (idx, usage) => db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?,?)').run(idx, generation(usage)),
    };
}

test('generation decoder reads f1.4, preserves cache buckets and accepts the context-only pending row', () => {
    assert.deepEqual(decodeGenMetadata(generation(stats())), { inputTokens: 100, outputTokens: 10, cachedWriteTokens: 0, cachedReadTokens: 20, thoughtTokens: 3 });
    const pending = field(1, field(9, field(10, count(1, 456))));
    assert.equal(decodeGenMetadata(pending).cwmEstTokens, 456);
    assert.equal(decodeGenMetadata(Buffer.from([0x0a, 0x80])), undefined);
});

test('generation usage is available before step completion and never double counted', t => {
    const f = fixture(t), reader = new SessionUsageReader(f.path);
    f.step(5, stats(), 1); f.gen(0, stats());
    assert.equal(reader.read().usage.totalTokens, 130);
    f.step(5, stats());
    assert.equal(reader.read(true), undefined);
});

test('a missing middle generation is back-filled once and a late generation does not repeat it', t => {
    const f = fixture(t), warnings = [], reader = new SessionUsageReader(f.path, message => warnings.push(message));
    f.step(1, stats(100)); f.step(3, stats(200)); f.step(5, stats(300));
    f.gen(0, stats(100)); f.gen(2, stats(300));
    assert.equal(reader.read().calls, 2);
    assert.equal(reader.read(true).usage.inputTokens, 200);
    assert.equal(reader.read(true), undefined);
    f.gen(1, stats(200));
    assert.equal(reader.read(true), undefined);
    assert.equal(warnings.filter(message => message.includes('usage-gap')).length, 1);
    f.gen(3, stats(400)); f.step(7, stats(400));
    assert.equal(reader.read().usage.inputTokens, 400);
});

test('identical token bills preserve separate calls while matching both tables by occurrence', t => {
    const f = fixture(t), reader = new SessionUsageReader(f.path);
    for (const idx of [1, 3, 5]) f.step(idx, stats());
    f.gen(0, stats()); f.gen(1, stats());
    assert.equal(reader.read().calls, 2);
    assert.equal(reader.read(true).calls, 1);
    f.gen(2, stats());
    assert.equal(reader.read(true), undefined);
});

test('a zero generation that later acquires billing at the same idx is read again', t => {
    const f = fixture(t), reader = new SessionUsageReader(f.path);
    f.gen(0, Buffer.alloc(0));
    assert.equal(reader.read(), undefined);
    f.gen(0, stats());
    assert.equal(reader.read().calls, 1);
    assert.equal(reader.read(), undefined);
});

test('legacy steps include lower indices completed after the previous read', t => {
    const f = fixture(t, false), reader = new SessionUsageReader(f.path);
    f.step(10, stats(100), 1); f.step(11, stats(200));
    assert.equal(reader.read().usage.inputTokens, 200);
    f.step(10, stats(100));
    assert.equal(reader.read().usage.inputTokens, 100);
    assert.equal(reader.read(), undefined);
});

test('loading an existing session excludes old usage, including a previous step-only backfill', t => {
    const f = fixture(t);
    f.step(1, stats());
    const reader = new SessionUsageReader(f.path);
    f.gen(0, stats());
    assert.equal(reader.read(true), undefined);
    f.gen(1, stats()); f.step(3, stats());
    assert.equal(reader.read().calls, 1);
});

test('merged database usage keeps raw multi-call totals at the stream boundary', async () => {
    const turn = new AcpTurn('usage-test');
    turn.produced = true;
    turn.events.push({ kind: 'done', result: { stopReason: 'end_turn' } });
    const chunks = [];
    for await (const chunk of pumpStep(turn, {
        recordUsage() {}, consumeStepUsage: async () => ({ exact: true, calls: 2,
            usage: { inputTokens: 600, outputTokens: 20, cachedReadTokens: 200, totalTokens: 820 } }),
    })) chunks.push(chunk);
    assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.totalTokens, 820);
});

test('a restored DB locked during initialization recovers its baseline without billing old history', t => {
    const f = fixture(t), warnings = [];
    f.step(1, stats()); f.gen(0, stats());
    f.db.exec('BEGIN EXCLUSIVE');
    let reader;
    try { reader = new SessionUsageReader(f.path, message => warnings.push(message)); }
    finally { f.db.exec('ROLLBACK'); }
    assert.ok(warnings.some(message => message.includes('usage DB unavailable')));
    assert.equal(reader.read(true), undefined);
    f.step(3, stats(200)); f.gen(1, stats(200));
    assert.equal(reader.read(true).usage.inputTokens, 200);
});
