let bridge;
let activeSessionId = null;
let selectionError = null;
let selectionVersion = 0;
const onSession = snapshot => { selectionVersion++; activeSessionId = snapshot?.sessionId ?? null; selectionError = null; };
module.exports = {
  async onLoad() {
    const { startHttpBridge } = await import('./http-bridge.js');
    bridge = await startHttpBridge();
    pi.events.on('session:activated', onSession);
    const version = selectionVersion;
    try {
      const active = await pi.session.getActive();
      if (version === selectionVersion) onSession(active);
    } catch (error) {
      selectionError = String(error?.message ?? error);
      console.warn(`antigravity-acp: selected session unavailable: ${selectionError}`);
    }
  },
  async onUnload() {
    pi.events.off('session:activated', onSession);
    selectionVersion++;
    await bridge?.close(); bridge = undefined;
  },
  onRendererCall(method, args = {}) {
    if (!bridge) throw new Error('Antigravity bridge is not ready');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
      throw new Error('Monitor methods do not accept arguments');
    if (method !== 'monitor.snapshot' && method !== 'monitor.refresh')
      throw new Error(`Unknown monitor method: ${method}`);
    return { ...bridge.monitorSnapshot(activeSessionId, method === 'monitor.refresh'), selectionError };
  },
};
