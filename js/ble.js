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
      : { available: false, running: false, scanning: false, advertising: false, relayEnabled: false, queuedPacketCount: 0, peerCount: 0, error: 'Native Android BLE discovery is unavailable in this web build.' };
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
  function setIdentity(userId) {
    const native = bridge();
    if (!native || typeof native.setBleIdentity !== 'function') return false;
    try { native.setBleIdentity(String(userId || '')); return true; } catch (_) { return false; }
  }
  function setRelayEnabled(enabled) {
    const native = bridge();
    if (!native || typeof native.setBleRelayEnabled !== 'function') return { ok: false, error: 'Opt-in relay is available only on Android.' };
    try { return parse(native.setBleRelayEnabled(!!enabled), { ok: false, error: 'Could not update relay setting.' }); }
    catch (_) { return { ok: false, error: 'Could not update relay setting.' }; }
  }
  function acknowledgePacket(packetId) {
    const native = bridge();
    if (!native || typeof native.acknowledgeBlePacket !== 'function') return { ok: false };
    try { return parse(native.acknowledgeBlePacket(String(packetId || '')), { ok: false }); }
    catch (_) { return { ok: false }; }
  }
  function sendPacket(packet) {
    const native = bridge();
    if (!native || typeof native.sendBlePacket !== 'function') return { ok: false, error: 'Native BLE packet transport is unavailable.' };
    try { return parse(native.sendBlePacket(JSON.stringify(packet)), { ok: false, error: 'Native BLE transport returned an invalid result.' }); }
    catch (_) { return { ok: false, error: 'Could not pass an encrypted packet to Android BLE.' }; }
  }
  function drainPackets() {
    const native = bridge();
    if (!native || typeof native.drainBlePackets !== 'function') return [];
    const packets = parse(native.drainBlePackets(), []);
    return Array.isArray(packets) ? packets : [];
  }
  return Object.freeze({ detect, getStatus, startScan, stopScan, setIdentity, setRelayEnabled,
    acknowledgePacket, sendPacket, drainPackets });
})();
