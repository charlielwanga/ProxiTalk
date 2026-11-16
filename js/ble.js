/* Native Bluetooth mesh transport is not implemented in this web build. */
const ProxiBLE = Object.freeze({
  SERVICE_UUID: null,
  detect() { return 'unavailable'; },
  getMode() { return 'unavailable'; },
  isScanning() { return false; },
  async startScan() { return { ok: false, error: 'Native BLE mesh transport is not available in this build' }; },
  async sendPacket() { return { ok: false, error: 'Native BLE mesh transport is not available in this build' }; },
  stopScan() {},
});
