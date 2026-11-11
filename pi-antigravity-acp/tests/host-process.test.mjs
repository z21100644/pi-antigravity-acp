import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAcp } from '../lib/host.js';

test('Windows ACP child has no console and keeps bidirectional pipes and owned shutdown',
    { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
        // Query the child's own native console; a zero MainWindowHandle in the
        // parent would not establish whether Windows allocated a console.
        const script = [
            `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AcpConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'`,
            '[Console]::WriteLine([AcpConsoleProbe]::GetConsoleWindow().ToInt64())',
            '[Console]::Error.WriteLine("ACP probe diagnostic")',
            '$reply = [Console]::ReadLine()',
            '[Console]::WriteLine("reply:" + $reply)',
            'Start-Sleep -Seconds 60',
        ].join('; ');
        const binary = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = spawnAcp([binary, '-NoProfile', '-NonInteractive', '-Command', script], tmpdir());
        const lines = createInterface({ input: child.stdout });
        t.after(async () => { child.terminate(); await child.waitForExit(); lines.close(); });
        const [handle] = await once(lines, 'line');
        assert.equal(handle, '0', 'background ACP must not acquire a Windows console');
        const response = once(lines, 'line');
        child.stdin.write('ACP stdin round trip\n');
        assert.equal((await response)[0], 'reply:ACP stdin round trip');
        child.terminate();
        await child.exited;
        await child.waitForExit();
        assert.match(child.stderrTail(), /ACP probe diagnostic/);
    });
