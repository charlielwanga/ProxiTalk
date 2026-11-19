/* Foreground one-to-one WebRTC calls. Signaling is authenticated, E2E-encrypted,
 * and device-signed; media uses WebRTC DTLS-SRTP. Direct-only ICE (STUN, no TURN)
 * means some networks will fail to connect. This is not an emergency service. */
const ProxiCalls = (() => {
  const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const VALID_KINDS = new Set(['offer', 'answer', 'ice', 'hangup', 'reject']);
  let deps = null;
  let call = null;
  let pollTimer = null;
  let pollCursor = null;
  let pollBusy = false;
  let callbacks = { onStateChange() {}, onIncoming() {}, onRemoteStream() {}, onLocalStream() {} };
  const seenSignals = new Set();
  const peerKeyCache = new Map();
  function newCallId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
      const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      return (char === 'x' ? random : (random & 3) | 8).toString(16);
    });
  }
  function validIceCandidate(candidate) {
    return candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 2048
      && (candidate.sdpMid == null || (typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 128))
      && (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex));
  }

  function state() { return call?.state || 'idle'; }
  function notify() { callbacks.onStateChange({ state: state(), call: call ? {
    id: call.id, contact: call.contact, mode: call.mode, direction: call.direction,
    muted: call.muted, videoEnabled: call.videoEnabled,
  } : null }); }
  function setState(value) { if (call) call.state = value; notify(); }
  function assertReady(contact) {
    if (!deps?.userId || !deps.profile?.public_key) throw new Error('Sign in and finish device-key setup before calling.');
    if (!contact?.userId || !contact?.publicKey) throw new Error('This contact has no verified call encryption key.');
    if (contact.userId === deps.userId) throw new Error('You cannot call yourself.');
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection !== 'function') throw new Error('This Android WebView or browser does not support secure calls.');
  }
  function parsePeerDescription(value, type) {
    if (!value || value.type !== type || typeof value.sdp !== 'string' || value.sdp.length > 30000) throw new Error('Invalid call description.');
    return new RTCSessionDescription(value);
  }
  async function obtainMedia(mode) {
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: mode === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false };
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  async function createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 0 });
    call.pc = pc;
    pc.onicecandidate = event => {
      if (!event.candidate || !call || call.pc !== pc) return;
      const candidate = event.candidate.toJSON();
      if (!call.offerSent) call.pendingLocalIce.push(candidate);
      else sendSignal('ice', { candidate }).catch(error => fail(error));
    };
    pc.ontrack = event => {
      if (!call || call.pc !== pc) return;
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      callbacks.onRemoteStream(stream, call.mode);
    };
    pc.onconnectionstatechange = () => {
      if (!call || call.pc !== pc) return;
      if (pc.connectionState === 'connected') setState('active');
      else if (['failed', 'closed'].includes(pc.connectionState)) {
        if (pc.connectionState === 'failed') setState('failed');
        if (pc.connectionState === 'closed') finish(false);
      } else if (['connecting', 'new'].includes(pc.connectionState) && call.state !== 'incoming' && call.state !== 'outgoing') setState('connecting');
    };
    if (call.localStream) call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
    return pc;
  }
  async function sendSignal(kind, payload, targetCall = call) {
    if (!targetCall || !deps) throw new Error('No call session is active.');
    if (!VALID_KINDS.has(kind)) throw new Error('Unsupported call signal.');
    const body = { v: 1, kind, call_id: targetCall.id, sender_id: deps.userId,
      recipient_id: targetCall.contact.userId, payload };
    const ciphertext = await deps.crypto.encryptFor(targetCall.contact.publicKey, JSON.stringify(body));
    const signed = await deps.crypto.signPacket({ v: 1, kind, call_id: targetCall.id,
      sender_id: deps.userId, recipient_id: targetCall.contact.userId,
      sent_at: new Date().toISOString(), ciphertext });
    await deps.cloud.sendCallSignal({ callId: targetCall.id, senderId: deps.userId,
      recipientId: targetCall.contact.userId, kind, ciphertext: signed });
  }
  async function flushLocalIce() {
    if (!call || !call.offerSent) return;
    const queued = call.pendingLocalIce.splice(0);
    for (const candidate of queued) await sendSignal('ice', { candidate });
  }
  async function start(contact, mode = 'audio') {
    if (call) throw new Error('Finish the current call before starting another.');
    assertReady(contact);
    if (!['audio', 'video'].includes(mode)) throw new Error('Choose an audio or video call.');
    const active = { id: newCallId(), contact, mode, direction: 'outgoing', state: 'preparing', muted: false,
      videoEnabled: mode === 'video', pendingLocalIce: [], pendingRemoteIce: [], offerSent: false, localStream: null, pc: null, timer: null };
    call = active; notify();
    try {
      active.localStream = await obtainMedia(mode);
      callbacks.onLocalStream(active.localStream, mode);
      const pc = await createPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      setState('outgoing');
      await sendSignal('offer', { description: pc.localDescription.toJSON(), mode });
      active.offerSent = true;
      await flushLocalIce();
      active.timer = setTimeout(() => { if (call === active && ['outgoing', 'connecting'].includes(active.state)) { sendSignal('hangup', { reason: 'timeout' }).catch(() => {}); finish(true, 'No answer. Call ended.'); } }, 65000);
      return { ok: true, callId: active.id };
    } catch (error) { await finish(false); throw error; }
  }
  async function accept() {
    if (!call || call.state !== 'incoming' || !call.offer) throw new Error('There is no incoming call to accept.');
    const active = call;
    clearTimeout(active.timer);
    active.timer = null;
    try {
      active.state = 'preparing'; notify();
      active.localStream = await obtainMedia(active.mode);
      callbacks.onLocalStream(active.localStream, active.mode);
      const pc = await createPeerConnection();
      await pc.setRemoteDescription(parsePeerDescription(active.offer.description, 'offer'));
      for (const candidate of active.pendingRemoteIce.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(candidate));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal('answer', { description: pc.localDescription.toJSON() });
      active.offerSent = true;
      await flushLocalIce();
      setState('connecting');
      return { ok: true };
    } catch (error) { await sendSignal('reject', { reason: 'media_or_setup_failed' }).catch(() => {}); await finish(false); throw error; }
  }
  async function decline() {
    if (!call || call.state !== 'incoming') return;
    await sendSignal('reject', { reason: 'declined' }).catch(() => {});
    finish(true, 'Call declined.');
  }
  async function end() {
    if (!call) return;
    const active = call;
    await sendSignal('hangup', { reason: 'ended' }, active).catch(() => {});
    finish(true, 'Call ended.');
  }
  function finish(keepState = false, message = '') {
    const old = call;
    if (!old) { if (message) callbacks.onStateChange({ state: 'idle', call: null, message }); return; }
    call = null;
    clearTimeout(old.timer);
    try { old.pc?.close(); } catch (_) {}
    old.localStream?.getTracks().forEach(track => track.stop());
    callbacks.onLocalStream(null, 'audio');
    callbacks.onRemoteStream(null, 'audio');
    callbacks.onStateChange({ state: keepState ? 'ended' : 'idle', call: null, message });
  }
  function fail(error) {
    console.warn('[ProxiCalls] call signaling/transport failed', error);
    if (call) setState('failed');
  }
  async function processSignal(row) {
    if (seenSignals.has(row.id)) { await deps.cloud.deleteCallSignal(row.id).catch(() => {}); return; }
    seenSignals.add(row.id);
    if (seenSignals.size > 500) seenSignals.clear();
    try {
      if (!VALID_KINDS.has(row.kind) || !row.ciphertext || row.created_at && Date.now() - Date.parse(row.created_at) > 10 * 60_000) return;
      let peer = peerKeyCache.get(row.sender_id);
      if (!peer) {
        peer = await deps.cloud.findDirectoryByUserId(row.sender_id);
        if (peer) peerKeyCache.set(row.sender_id, peer);
      }
      if (!peer?.signing_public_key || !await deps.crypto.verifyPacket(row.ciphertext, peer.signing_public_key)) return;
      const packet = row.ciphertext;
      if (packet.kind !== row.kind || packet.call_id !== row.call_id || packet.sender_id !== row.sender_id
        || packet.recipient_id !== deps.userId || !packet.ciphertext) return;
      const body = JSON.parse(await deps.crypto.decryptFromMe(packet.ciphertext));
      if (body.v !== 1 || body.kind !== row.kind || body.call_id !== row.call_id
        || body.sender_id !== row.sender_id || body.recipient_id !== deps.userId || !body.payload) return;
      await routeSignal(row, body, peer);
    } catch (error) { console.warn('[ProxiCalls] rejected invalid signaling packet', error); }
    finally { await deps.cloud.deleteCallSignal(row.id).catch(() => {}); }
  }
  async function routeSignal(row, body, peer) {
    const payload = body.payload;
    if (row.kind === 'offer') {
      if (call) {
        const busy = { id: row.call_id, contact: { userId: row.sender_id, publicKey: peer.public_key }, pendingLocalIce: [] };
        sendSignal('reject', { reason: 'busy' }, busy).catch(() => {});
        return;
      }
      if (!['audio', 'video'].includes(payload.mode)) return;
      parsePeerDescription(payload.description, 'offer');
      const contact = await deps.getContact(peer);
      if (!contact) {
        const unknown = { id: row.call_id, contact: { userId: row.sender_id, publicKey: peer.public_key }, pendingLocalIce: [] };
        sendSignal('reject', { reason: 'not_in_contacts' }, unknown).catch(() => {});
        return;
      }
      call = { id: row.call_id, contact, mode: payload.mode, direction: 'incoming', state: 'incoming', offer: payload,
        muted: false, videoEnabled: payload.mode === 'video', pendingLocalIce: [], pendingRemoteIce: [], offerSent: false,
        localStream: null, pc: null, timer: setTimeout(() => { if (call?.id === row.call_id && call.state === 'incoming') finish(true, 'Missed call.'); }, 60000) };
      callbacks.onIncoming({ contact, mode: payload.mode }); notify();
      return;
    }
    if (!call || call.id !== row.call_id || call.contact.userId !== row.sender_id) return;
    if (row.kind === 'answer' && call.direction === 'outgoing' && call.pc && payload.description) {
      clearTimeout(call.timer);
      await call.pc.setRemoteDescription(parsePeerDescription(payload.description, 'answer'));
      for (const candidate of call.pendingRemoteIce.splice(0)) await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
      setState('connecting');
    } else if (row.kind === 'ice' && validIceCandidate(payload.candidate)) {
      if (!call.pc || !call.pc.remoteDescription) call.pendingRemoteIce.push(payload.candidate);
      else await call.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } else if (row.kind === 'reject' || row.kind === 'hangup') {
      finish(true, row.kind === 'reject' ? 'Call declined or unavailable.' : 'Call ended by the other person.');
    }
  }
  async function poll() {
    if (!deps || pollBusy || document.visibilityState === 'hidden') return;
    pollBusy = true;
    try {
      const rows = await deps.cloud.receiveCallSignals(deps.userId, pollCursor);
      for (const row of rows) await processSignal(row);
      const latest = (rows || []).reduce((max, row) => Math.max(max, Date.parse(row.created_at) || 0), Date.parse(pollCursor) || 0);
      pollCursor = new Date(latest).toISOString();
      await deps.cloud.pruneCallSignals().catch(() => {});
    } catch (error) { console.warn('[ProxiCalls] inbox check failed', error); }
    finally { pollBusy = false; }
  }
  function initialize(options) {
    deps = options;
    peerKeyCache.clear();
    seenSignals.clear();
    pollCursor = new Date(Date.now() - 10 * 60_000).toISOString();
    if (pollTimer) clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 1500);
    document.addEventListener('visibilitychange', onVisibility);
  }
  function onVisibility() { if (document.visibilityState === 'visible') poll(); }
  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    if (call) finish(false);
    deps = null;
  }
  function toggleMute() {
    if (!call?.localStream) return false;
    call.muted = !call.muted;
    call.localStream.getAudioTracks().forEach(track => { track.enabled = !call.muted; });
    notify(); return call.muted;
  }
  function toggleVideo() {
    if (!call?.localStream || call.mode !== 'video') return false;
    call.videoEnabled = !call.videoEnabled;
    call.localStream.getVideoTracks().forEach(track => { track.enabled = call.videoEnabled; });
    notify(); return call.videoEnabled;
  }
  return Object.freeze({ initialize, stop, start, accept, decline, end, getState: state,
    setCallbacks(value) { callbacks = { ...callbacks, ...value }; }, toggleMute, toggleVideo });
})();
