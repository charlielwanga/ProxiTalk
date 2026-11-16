/* Wi-Fi Direct transport is not implemented in this web build. */
const ProxiWiFiDirect = Object.freeze({
  detect() { return 'unavailable'; },
  getMode() { return 'unavailable'; },
  setOnPacket() {},
  async start() { return { ok: false, error: 'Wi-Fi Direct is not implemented' }; },
  async sendPacket() { return { ok: false, error: 'Wi-Fi Direct is not implemented' }; },
  stop() {},
});
