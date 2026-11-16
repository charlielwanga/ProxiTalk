/* SMS forwarding is disabled until consent, auth, rate limits, and a provider are set up. */
const ProxiSMS = Object.freeze({
  encode() { throw new Error('SMS bridge is disabled'); },
  decode() { return null; },
  async send() { return { ok: false, error: 'SMS bridge is disabled' }; },
});
