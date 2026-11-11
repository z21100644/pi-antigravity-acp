import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityRuntime } from '../lib/runtime.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { toAcpRequest } from '../http-bridge.js';

const model = 'gemini-4-argon';
const tool = { name: 'read', description: 'Read a fixture', parameters: { type: 'object', properties: {} } };
const system = { role: 'system', id: 'system', content: [{ type: 'text', text: 'Strict effort verification.' }] };
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] });
const collect = async iterable => { const result = []; for await (const item of iterable) result.push(item); return result; };
const assistant = (id, chunks) => ({ role: 'assistant', id, source: { kind: 'model', provider: 'antigravity', model },
    content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block) });
const request = extra => ({ provider: 'antigravity', model, sessionId: 'strict', purpose: 'main',
    reasoningEffort: 'high', tools: [tool], messages: [system, user('u1', 'hello')], ...extra });
const lines = path => existsSync(path) ? readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
function fixture(t, { env = {}, config = {}, home = mkdtempSync(join(tmpdir(),'pi-strict-effort-')) } = {}) {
    const log = join(home, 'prompts.jsonl'), events = join(home, 'events.jsonl'), records = [];
    const runtime = new AntigravityRuntime({
        config: { ...DEFAULT_CONFIG, home, command: join(import.meta.dirname,'fake-agy.mjs'), warmup: false,
            patchScript: join(home,'absent.py'), coldSwitchSettleMs: 0, ...config },
        spawnAcp(argv,cwd) {
            const child = spawn(process.execPath, argv, { cwd, windowsHide: true, stdio: ['pipe','pipe','pipe'],
                env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_EVENTS: events, FAKE_AGY_LOAD: '1', ...env } });
            let stderr = ''; child.stderr.on('data', data => { stderr += data; });
            const closed = new Promise(resolve=>child.once('close',resolve));
            return { pid: child.pid, stdin: child.stdin, stdout: child.stdout,
                exited: new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal}))),
                waitForExit: ()=>closed, terminate: ()=>child.kill(), stderrTail: ()=>stderr };
        },
        runCommand: async argv => ({code:0, stdout:argv.includes('--version')?'fake-agy 0.0.1':'{}',stderr:''}),
        readImage: async ()=>undefined, canReadImages: ()=>false,
        log: { info: message=>records.push(message), warn: message=>records.push(message) },
    });
    t.after(()=>runtime.dispose());
    return { runtime, home, records, prompts:()=>lines(log), events:()=>lines(events) };
}
function resume(first, input, effort = 'high') {
    const call = first.find(chunk=>chunk.type==='block-end' && chunk.block.type==='tool-call').block;
    return { ...input, reasoningEffort: effort, messages: [...input.messages, assistant('a1',first),
        {role:'tool',toolCallId:call.id,content:[{type:'text',text:'fixture result'}]}] };
}

test('HTTP preserves the PI effort and rejects unavailable aliases instead of silently substituting', () => {
    const body = {model,messages:[{role:'user',content:'hello'}],tools:[],reasoning_effort:'low'};
    assert.equal(toAcpRequest(body,{'x-pi-acp-reasoning':'high'}).reasoningEffort,'high');
    for(const value of ['off','minimal','xhigh','max','adaptive','',false]) {
        assert.throws(()=>toAcpRequest(body,{'x-pi-acp-reasoning':value}), /effort/i);
    }
});

test('an unavailable high effort fails before prompting instead of choosing medium', async t => {
    const f = fixture(t,{env:{FAKE_AGY_EFFORTS:'low,medium'}});
    await assert.rejects(collect(f.runtime.stream(request())), /effort|thought_level/i);
    assert.equal(f.prompts().length,0);
});

test('a missing reasoning selector and a missing configuration acknowledgement cannot claim success', async t => {
    for(const env of [{FAKE_AGY_NO_THOUGHT_LEVEL:'1'},{FAKE_AGY_CONFIG_NO_ACK:'1'},{FAKE_AGY_CONFIG_EMPTY_ACK:'1'}]) {
        const f = fixture(t,{env});
        await assert.rejects(collect(f.runtime.stream(request())), /config|thought_level|effort/i);
        assert.equal(f.prompts().length,0);
    }
});

test('a fixed medium model refuses a high request instead of lowering it', async t => {
    const f = fixture(t);
    await assert.rejects(collect(f.runtime.stream(request({model:'gpt-oss-120b-medium'}))), /effort|medium/i);
    assert.equal(f.prompts().length,0);
});

test('each prompt reasserts effort even when the cached option still says high', async t => {
    const f = fixture(t), input=request();
    const first=await collect(f.runtime.stream(input));
    const conv=f.runtime.conversations.get('strict|main');
    await f.runtime.process.setConfigOption(conv.sessionId,'thought_level','low');
    await collect(f.runtime.stream({...input,messages:[...input.messages,assistant('a1',first),user('u2','next')]}));
    assert.deepEqual(f.prompts().map(item=>item.level),['high','high']);
});

test('claiming a warm session reasserts the PI effort before its first prompt', async t => {
    const f=fixture(t);
    await f.runtime.warmup({system:'',tools:[tool],model,reasoningEffort:'high'});
    f.runtime.standbyEnabled=false;
    const entry=f.runtime.standbyPool[0];
    assert.ok(entry);
    await f.runtime.process.setConfigOption(entry.sessionId,'thought_level','low');
    await collect(f.runtime.stream(request({messages:[user('u1','warm claim')]})));
    assert.equal(f.prompts()[0].session,entry.sessionId);
    assert.equal(f.prompts()[0].level,'high');
});

for (const warm of [false,true]) {
    for (const [from,to,nextModel] of [['low','high',model],['high','low',model],['high','high','gemini-3.8-flash']]) {
        test(`${warm?'warm':'cold'} tool resumption starts a new executor when ${from} changes to ${to} on ${nextModel}`, async t => {
            const f=fixture(t,{env:{FAKE_AGY_SKIP_HISTORY:'1'}});
            if(warm) {
                await f.runtime.warmup({system:system.content[0].text,tools:[tool],model,reasoningEffort:from});
                f.runtime.standbyEnabled=false;
            }
            const input=request({reasoningEffort:from,messages:[system,user('u1','CALL read {}')]});
            const first=await collect(f.runtime.stream(input));
            const oldSession=f.runtime.conversations.get('strict|main').sessionId;
            const second=await collect(f.runtime.stream({...resume(first,input,to),model:nextModel}));
            assert.equal(second.at(-1).reason.kind,'stop');
            assert.equal(second.filter(chunk=>chunk.type==='block-end'&&chunk.block.type==='tool-call').length,0);
            const prompts=f.prompts();
            assert.equal(prompts.length,2,'a configuration ACK cannot change an executor that already started');
            assert.notEqual(prompts[1].session,oldSession);
            assert.equal(prompts[1].level,to);
            assert.equal(prompts[1].model,nextModel);
            assert.match(prompts[1].rawText,/<tool_result[^>]*>\s*fixture result/);
            assert.match(prompts[1].rawText,/Continue the task from the latest tool results above/);
            assert.ok(f.events().some(event=>event.method==='session/cancel'&&event.sessionId===oldSession));
            assert.ok(f.records.some(line=>line.includes('restarting executor')));
        });
    }
}

test('a reported downgrade while parked is repaired before the tool result resumes generation', async t => {
    const f=fixture(t), input=request({messages:[system,user('u1','CALL read {}')]});
    const first=await collect(f.runtime.stream(input));
    const conv=f.runtime.conversations.get('strict|main');
    const configOptions=await f.runtime.process.setConfigOption(conv.sessionId,'thought_level','low');
    f.runtime.handleSessionUpdate(conv,{sessionUpdate:'config_option_update',configOptions});
    await collect(f.runtime.stream(resume(first,input)));
    assert.equal(f.events().find(item=>item.method==='tool_result_received').level,'high');
});

test('long decode reasserts effort before starting another native prompt', async t => {
    const f=fixture(t), proc=await f.runtime.ensureReady(), prompt=proc.prompt.bind(proc);
    proc.prompt=async (...args)=>{
        const result=await prompt(...args);
        if(result.stopReason==='max_tokens') await proc.setConfigOption(args[0],'thought_level','low');
        return result;
    };
    await collect(f.runtime.stream(request({messages:[system,user('u1','MAXTOK')]})));
    assert.deepEqual(f.prompts().map(item=>item.level),['high','high']);
});

test('a reasoning downgrade during generation fails the turn and invalidates persistence', async t => {
    const f=fixture(t), iterator=f.runtime.stream(request({messages:[system,user('u1','SLEEP 300')]}));
    await iterator.next();
    const conv=f.runtime.conversations.get('strict|main');
    const configOptions=structuredClone(conv.configOptions);
    configOptions.find(option=>option.id==='thought_level').currentValue='low';
    f.runtime.handleSessionUpdate(conv,{sessionUpdate:'config_option_update',configOptions});
    await assert.rejects(collect(iterator), /configuration|thought_level|effort/i);
    assert.equal(conv.dirty,true);
    assert.equal(f.runtime.sessions.get('strict|main'),undefined);
});

test('an uninitialized selection is never treated as a confirmed fixed effort', t => {
    const f=fixture(t), conv=f.runtime.createConversation('empty|main','main');
    assert.throws(()=>f.runtime.assertSelection(conv,undefined,undefined),/configuration/i);
});

test('a zero thought billing sample neither changes the selected effort nor resubmits the prompt', async t => {
    const f=fixture(t), start=f.runtime.startPrompt.bind(f.runtime);
    f.runtime.startPrompt=(conv,...args)=>{
        start(conv,...args);
        let read=false;
        conv.usageReader={read:()=>{
            if(read)return undefined;
            read=true;
            return {exact:true,calls:1,usage:{inputTokens:10,outputTokens:5,thoughtTokens:0,cachedReadTokens:100,totalTokens:115}};
        }};
    };
    const chunks=await collect(f.runtime.stream(request()));
    assert.equal(chunks.at(-1).reason.kind,'stop');
    assert.equal(f.prompts().length,1);
    assert.equal(f.runtime.conversations.get('strict|main').effort,'high');
    assert.ok(f.records.some(line=>line.includes('zero-thought usage sample')&&line.includes('"confirmedEffort":"high"')));
});
