/**
 * Plain configuration for the PI Desktop Antigravity ACP extension.
 * @module pi-antigravity-acp/config
 */
/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'];
/** Defaults applied by the extension before constructing the runtime. */
export const DEFAULT_CONFIG = {
    provider: 'antigravity',
    displayName: 'Antigravity',
    command: '',
    home: '',
    contextWindow: 0,
    defaultEffort: 'high',
    autoPatch: false,
    patchScript: '',
    maxLiveSessions: 16,
    idleSessionTtlMs: 30 * 60_000,
    parkSettleMs: 250,
    coldSwitchSettleMs: 80,
    keepAliveMs: 15_000,
    relayAfterMs: 85_000,
    longDecodeContinuations: 3,
    warmup: true,
    quotaTtlMs: 120_000,
    traceTimings: false,
    numericEnumMode: 'lower',
};
/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value) {
    return EFFORTS.includes(value ?? '') ? value : undefined;
}
