let bridge;
module.exports = {
  async onLoad() {
    const { startHttpBridge } = await import('./http-bridge.js');
    bridge = await startHttpBridge();
  },
  async onUnload() { await bridge?.close(); bridge = undefined; },
};
