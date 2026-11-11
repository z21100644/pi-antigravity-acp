import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
/** Keep CLI login local without leaking the host's unrelated provider credentials. */
function childEnvironment() {
    const env = { HOME: homedir(), PYTHONUTF8: '1' };
    for (const key of [
        'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'WINDIR',
        'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ]) {
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    }
    return env;
}
export const spawnAcp = (argv, cwd) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-64 * 1024); });
    const { promise: exited, resolve } = Promise.withResolvers();
    child.once('error', error => resolve({ code: null, signal: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
    const closed = new Promise(resolveClosed => { child.once('close', () => resolveClosed()); });
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        pid: child.pid,
        exited,
        waitForExit: () => closed,
        terminate: () => { child.kill(); },
        stderrTail: () => stderr,
    };
};
export const runCommand = (argv, timeoutMs) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const child = spawn(argv[0], argv.slice(1), {
        cwd: homedir(), env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Command timed out after ${timeoutMs}ms: ${argv[0]}`)); }, timeoutMs);
    child.stdout.on('data', (data) => { stdout = (stdout + data.toString()).slice(-8 * 1024 * 1024); });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-256 * 1024); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    return promise;
};
