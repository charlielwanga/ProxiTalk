/* Android-only opt-in BLE discovery bridge. Packet transport and relay are not implemented yet. */
const ProxiBLE = (() => {
  function bridge() {
    const native = window.ProxiTalkNative;
    return native && typeof native.getBleStatus === 'function' ? native : null;
  }
  function parse(value, fallback) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  function detect() { return bridge() ? 'native-discovery' : 'unavailable'; }
  function getStatus() {
    const native = bridge();
    return native ? parse(native.getBleStatus(), { available: true, running: false, peerCount: 0, error: '' })
      : { available: false, running: false, scanning: false, advertising: false, peerCount: 0, error: 'Native Android BLE discovery is unavailable in this web build.' };
  }
  async function startScan() {
    const native = bridge();
    if (!native) return { ok: false, error: 'Native Android BLE discovery is unavailable in this web build.' };
    return parse(native.startBleDiscovery(), { ok: true, state: 'starting' });
  }
  function stopScan() {
    const native = bridge();
    if (native) return parse(native.stopBleDiscovery(), { ok: true, state: 'stopping' });
    return { ok: false, error: 'Native Android BLE discovery is unavailable in this web build.' };
  }
  return Object.freeze({ detect, getStatus, startScan, stopScan });
})();
