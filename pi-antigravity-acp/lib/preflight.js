/**
 * Startup preparation: locate the official `agy` binary, verify (and when
 * allowed, apply) the local context-window unlock, and lay out the isolated
 * Antigravity home that ACP sessions use.
 *
 * The isolated home keeps the user's global Antigravity rules, skills, and
 * MCP servers out of PI Desktop sessions and installs the `pi-desktop-bridge` agent, which
 * removes every built-in tool so the agent acts only through PI Desktop tools.
 * @module pi-antigravity-acp/preflight
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
/** Agent id installed in the isolated home. */
export const BRIDGE_AGENT = 'pi-desktop-bridge';
/** Minimum official CLI version offering every account model to every ACP client. */
export const MIN_AGY_VERSION = [1, 5, 1];
/** Context window the official binary enforces without the unlock. */
export const LOCKED_CONTEXT_WINDOW = 256_000;
/** Physical context window of the Gemini 4, Gemini 3.8, and Claude 5.5 families. */
export const UNLOCKED_CONTEXT_WINDOW = 1_048_576;
/** GPT-OSS 120B keeps its own 128K-class window and is not covered by the unlock. */
export const GPT_OSS_CONTEXT_WINDOW = 131_072;
function splitPathDirs(env, platform) {
    const raw = env.PATH ?? env.Path ?? '';
    const sep = platform === 'win32' ? ';' : delimiter;
    const dirs = [];
    for (const part of raw.split(sep)) {
        const cleaned = part.trim().replace(/^"(.*)"$/, '$1');
        if (cleaned.length > 0)
            dirs.push(cleaned);
    }
    return dirs;
}
/**
 * Locate the `agy` executable.
 * @param configured - configured absolute path, or empty.
 * @param options - optional platform/env overrides for testing.
 * @returns the executable path.
 */
export function resolveAgyBinary(configured, options = {}) {
    if (configured.length > 0) {
        if (!isAbsolute(configured))
            throw new Error(`antigravity-acp: command must be an absolute path, got ${configured}`);
        if (!existsSync(configured))
            throw new Error(`antigravity-acp: configured agy binary not found at ${configured}`);
        return configured;
    }
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const exeName = platform === 'win32' ? 'agy.exe' : 'agy';
    const candidates = [];
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0
            ? env.LOCALAPPDATA
            : join(home, 'AppData', 'Local');
        candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'));
        candidates.push(join(home, '.local', 'bin', 'agy.exe'));
    }
    else {
        candidates.push(join(home, '.local', 'bin', 'agy'));
    }
    for (const dir of splitPathDirs(env, platform)) {
        candidates.push(join(dir, exeName));
    }
    const found = candidates.find(candidate => existsSync(candidate));
    if (found === undefined) {
        throw new Error('antigravity-acp: the Antigravity CLI (agy) was not found; install it from https://antigravity.google/docs/install?tab=cli and sign in once with `agy`');
    }
    return found;
}
/**
 * Locate a working Python 3 command for `agy-patch.py`, skipping Windows Store
 * zero-byte `WindowsApps\python*.exe` alias stubs.
 * @param options - optional platform/env overrides for testing.
 * @returns command argv prefix (e.g. `['D:\\Python\\python.exe']` or `['C:\\Windows\\py.exe', '-3']`).
 */
export function resolvePythonArgv(options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
        return [existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3'];
    }
    const env = options.env ?? process.env;
    for (const dir of splitPathDirs(env, platform)) {
        if (/[/\\]Microsoft[/\\]WindowsApps(?:[/\\]|$)/i.test(dir))
            continue;
        for (const name of ['python.exe', 'python3.exe']) {
            const candidate = join(dir, name);
            try {
                if (statSync(candidate).size > 0)
                    return [candidate];
            }
            catch {
                // Candidate does not exist in this PATH entry.
            }
        }
    }
    const sysRoot = env.SystemRoot && env.SystemRoot.length > 0 ? env.SystemRoot : 'C:\\Windows';
    const pyLauncher = join(sysRoot, 'py.exe');
    if (existsSync(pyLauncher))
        return [pyLauncher, '-3'];
    return ['python'];
}
/**
 * Reject outdated official `agy` binaries that predate ACP multi-session support.
 * Non-semver diagnostic strings (`unknown`, test doubles) pass through.
 * @param version - version string from `readVersion`.
 * @param binary - resolved executable path.
 */
export function assertSupportedAgyVersion(version, binary) {
    const match = /^(?:antigravity(?:\s+cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b/i.exec(version.trim());
    if (match === null)
        return;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const [minMajor, minMinor, minPatch] = MIN_AGY_VERSION;
    const supported = major > minMajor
        || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
    if (!supported) {
        throw new Error(`antigravity-acp: Antigravity CLI ${version.trim()} at ${binary} is too old (requires >= 1.5.1); run \`agy update\` to upgrade`);
    }
}
/**
 * Default isolated home.
 * @returns `~/.pi-desktop/cache/antigravity-acp`; hosts may override this with their active profile's cache directory.
 */
export function defaultHome() {
    return join(homedir(), '.pi-desktop', 'cache', 'antigravity-acp');
}
/**
 * Seed or refresh the isolated `antigravity-oauth-token` file from the user's
 * default CLI home (`~/.gemini/antigravity-cli` or `~/.gemini/antigravity`)
 * whenever the host uses file-backed token storage (Windows / headless Linux)
 * or the user signed in again from a terminal.
 * @param home - isolated `--gemini-dir` root.
 * @param userHome - optional user home override for testing.
 */
export function syncOAuthToken(home, userHome = homedir()) {
    const appData = join(home, 'agy');
    const dst = join(appData, 'antigravity-oauth-token');
    const sources = [
        join(userHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
        join(userHome, '.gemini', 'antigravity', 'antigravity-oauth-token'),
    ];
    let newestSrc;
    for (const candidate of sources) {
        try {
            const st = statSync(candidate);
            if (st.size > 0 && (newestSrc === undefined || st.mtimeMs > newestSrc.mtimeMs)) {
                newestSrc = { path: candidate, mtimeMs: st.mtimeMs };
            }
        }
        catch {
            // Source token file does not exist.
        }
    }
    if (newestSrc === undefined)
        return;
    try {
        const dstStat = statSync(dst);
        if (dstStat.size > 0 && dstStat.mtimeMs >= newestSrc.mtimeMs)
            return;
    }
    catch {
        // Destination token file does not exist yet.
    }
    mkdirSync(appData, { recursive: true });
    copyFileSync(newestSrc.path, dst);
    try {
        chmodSync(dst, 0o600);
    }
    catch {
        // Mode bits are advisory on Windows.
    }
}
/**
 * Write the isolated Antigravity home: bridge agent and ACP settings.
 * @param home - absolute home directory used as `--gemini-dir`.
 * @param userHome - optional user home override for testing.
 * @returns the empty workspace directory used as every session's cwd.
 */
export function prepareHome(home, userHome = homedir()) {
    const agentDir = join(home, 'config', 'plugins', BRIDGE_AGENT, 'agents');
    mkdirSync(agentDir, { recursive: true });
    writeIfChanged(join(home, 'config', 'plugins', BRIDGE_AGENT, 'plugin.json'), `${JSON.stringify({ name: BRIDGE_AGENT }, null, 2)}\n`);
    writeIfChanged(join(agentDir, `${BRIDGE_AGENT}.md`), [
        '---',
        `name: ${BRIDGE_AGENT}`,
        'description: "PI Desktop primary-model bridge: no built-in tools, harness tools only"',
        'tools: []',
        'excludeDefaultComponents: true',
        'mainAgent: true',
        '---',
        'Follow the appended system instructions exactly. Act only through the harness tools you are given.',
        '',
    ].join('\n'));
    const appData = join(home, 'agy');
    mkdirSync(appData, { recursive: true });
    syncOAuthToken(home, userHome);
    const settingsPath = join(appData, 'settings.json');
    const settings = readJson(settingsPath);
    writeIfChanged(settingsPath, `${JSON.stringify({ ...settings, toolPermission: 'request-review', agentMode: '' }, null, 2)}\n`);
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    return workspace;
}
/**
 * Check the context-window unlock and apply it when allowed.
 * @param binary - agy executable.
 * @param script - unlock script path.
 * @param apply - whether to patch a locked binary.
 * @param run - helper command runner.
 * @returns the unlock state.
 */
export async function checkUnlock(binary, script, apply, run, options = {}) {
    if (!existsSync(script)) {
        return { status: 'unknown', applied: false, detail: `unlock script not found at ${script}; the 256K default applies` };
    }
    const python = resolvePythonArgv(options);
    const dry = await run([...python, script, '--binary', binary, '--dry-run'], 120_000);
    const text = `${dry.stdout}\n${dry.stderr}`;
    if (/all gates already unlocked/i.test(text))
        return { status: 'unlocked', applied: false, detail: 'context gates already unlocked' };
    if (!/dry run complete/i.test(text)) {
        return { status: 'unknown', applied: false, detail: `unlock check inconclusive (exit ${dry.code ?? 'null'})` };
    }
    if (!apply)
        return { status: 'locked', applied: false, detail: 'binary is locked to 256K and autoPatch is off' };
    const patched = await run([...python, script, '--binary', binary, '--in-place'], 300_000);
    if (patched.code !== 0) {
        return { status: 'locked', applied: false, detail: `unlock failed (exit ${patched.code ?? 'null'}): ${patched.stderr.trim().split('\n').slice(-2).join(' ')}` };
    }
    const verify = await run([...python, script, '--binary', binary, '--dry-run'], 120_000);
    return /all gates already unlocked/i.test(`${verify.stdout}\n${verify.stderr}`)
        ? { status: 'unlocked', applied: true, detail: 'context gates unlocked by this preflight' }
        : { status: 'unknown', applied: true, detail: 'unlock applied but verification was inconclusive' };
}
/**
 * Read the agy version.
 * @param binary - agy executable.
 * @param run - helper command runner.
 * @returns the version text, or `unknown`.
 */
export async function readVersion(binary, run) {
    try {
        const result = await run([binary, '--version'], 30_000);
        return (result.stdout.trim() || result.stderr.trim()).split('\n')[0] ?? 'unknown';
    }
    catch (_versionFailure) {
        // The version is diagnostic only.
        return 'unknown';
    }
}
/**
 * Default unlock script location.
 * @returns `~/.gemini/antigravity/tools/agy-patch.py`.
 */
export function defaultPatchScript() {
    return join(homedir(), '.gemini', 'antigravity', 'tools', 'agy-patch.py');
}
function writeIfChanged(path, content) {
    if (existsSync(path) && readFileSync(path, 'utf8') === content)
        return;
    writeFileSync(path, content);
}
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch (_missingSettings) {
        // A missing or unreadable settings file starts empty.
        return {};
    }
}
