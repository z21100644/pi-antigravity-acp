import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, EFFORTS } from "./config.js";
/** Same bounds as the runtime configuration; malformed input must not silently alter tool deadlines. */
const NUMBER_BOUNDS = {
    contextWindow: [0, Number.MAX_SAFE_INTEGER], maxLiveSessions: [1, 64],
    idleSessionTtlMs: [10_000, Number.MAX_SAFE_INTEGER], parkSettleMs: [0, 5_000],
    coldSwitchSettleMs: [0, 2_000],
    keepAliveMs: [1_000, Number.MAX_SAFE_INTEGER], relayAfterMs: [5_000, 165_000],
    longDecodeContinuations: [0, 16], quotaTtlMs: [5_000, Number.MAX_SAFE_INTEGER],
};
export function loadConfig(agentDir) {
    const path = process.env.PI_DESKTOP_ANTIGRAVITY_CONFIG ?? join(agentDir, 'antigravity-acp.json');
    const config = { ...DEFAULT_CONFIG, home: join(agentDir, 'cache', 'antigravity-acp') };
    if (!existsSync(path)) {
        if (process.env.PI_DESKTOP_ANTIGRAVITY_CONFIG !== undefined)
            throw new Error(`Antigravity config not found: ${path}`);
        return config;
    }
    const input = JSON.parse(readFileSync(path, 'utf8'));
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error(`Antigravity config must be an object: ${path}`);
    for (const [key, value] of Object.entries(input)) {
        if (!Object.hasOwn(DEFAULT_CONFIG, key))
            throw new Error(`Unknown Antigravity setting: ${key}`);
        const bounds = NUMBER_BOUNDS[key];
        if (bounds !== undefined) {
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < bounds[0] || value > bounds[1]) {
                throw new Error(`Antigravity ${key} must be an integer in ${bounds[0]}..${bounds[1]}`);
            }
        }
        else if (typeof value !== typeof DEFAULT_CONFIG[key]) {
            throw new Error(`Antigravity ${key} must be ${typeof DEFAULT_CONFIG[key]}`);
        }
        if (key === 'defaultEffort' && !EFFORTS.includes(value))
            throw new Error('Antigravity defaultEffort must be low, medium, or high');
        if (key === 'numericEnumMode' && value !== 'dispatch' && value !== 'lower')
            throw new Error('Antigravity numericEnumMode must be dispatch or lower');
        Object.assign(config, { [key]: value });
    }
    if (config.home.length > 0)
        config.home = resolve(config.home);
    return config;
}
