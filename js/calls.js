/* Live call signaling and media transport are not implemented. */
const ProxiCalls = Object.freeze({
  getState() { return 'unavailable'; },
  setOnStateChange() {},
  async startCall() { return { ok: false, error: 'Live call transport is not implemented' }; },
  acceptCall() { return { ok: false }; },
  declineCall() {},
  endCall() {},
  toggleMute() { return false; },
  async pushToTalk() { return { ok: false, error: 'Push-to-talk is not implemented' }; },
});
