/* Cloud integration intentionally disabled.
 * The previous public policies allowed anonymous access. Do not restore a
 * browser-side Supabase client until sign-in, per-user RLS, and packet-level
 * authorization are implemented and tested.
 */
const ProxiCloud = Object.freeze({
  enabled: false,
  getConfig() { return { enabled: false }; },
  async pushPackets() { return { ok: false, reason: 'cloud disabled pending secure authentication' }; },
  async pullPackets() { return []; },
  async markDelivered() {},
  async gatewaySync() { return { ok: false, reason: 'cloud disabled pending secure authentication' }; },
  async smsFallback() { return { ok: false, reason: 'SMS bridge disabled' }; },
  async heartbeat() { return { ok: false, reason: 'cloud disabled pending secure authentication' }; },
  setOnline() {},
  isOnline() { return false; },
  getLastSync() { return null; },
});
