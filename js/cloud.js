/* Authenticated Supabase directory and ciphertext mailbox. RLS is the trust boundary. */
const ProxiCloud = (() => {
  const cfg = window.ProxiTalkConfig;
  const endpoint = cfg.supabaseUrl + '/rest/v1/';

  async function api(path, options = {}) {
    const token = await ProxiAuth.accessToken();
    if (!token) throw new Error('Sign in to use online messaging');
    const response = await fetch(endpoint + path, {
      ...options,
      headers: {
        apikey: cfg.publishableKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.hint || 'Cloud request failed');
      error.status = response.status;
      error.code = data?.code || null;
      throw error;
    }
    return data;
  }

  async function findDirectoryById(proxiId) {
    const id = encodeURIComponent('eq.' + String(proxiId).toUpperCase());
    const rows = await api(`proxitalk_directory?proxitalk_id=${id}&select=user_id,proxitalk_id,display_name,public_key,signing_public_key&limit=1`);
    return rows?.[0] || null;
  }
  async function findDirectoryByUserId(userId) {
    const id = encodeURIComponent('eq.' + userId);
    const rows = await api(`proxitalk_directory?user_id=${id}&select=user_id,proxitalk_id,display_name,public_key,signing_public_key&limit=1`);
    return rows?.[0] || null;
  }
  async function createDirectoryProfile(profile) {
    const rows = await api('proxitalk_directory', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: profile.userId,
        proxitalk_id: profile.proxiId,
        display_name: profile.displayName,
        public_key: profile.publicKey,
        signing_public_key: profile.signingPublicKey,
      }),
    });
    return rows?.[0] || null;
  }

  async function updateDirectorySigningKey(userId, signingPublicKey) {
    const id = encodeURIComponent('eq.' + userId);
    const rows = await api(`proxitalk_directory?user_id=${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ signing_public_key: signingPublicKey }),
    });
    return rows?.[0] || null;
  }

  async function sendEncryptedMessage(senderId, recipient, plaintext) {
    // UI contacts use camelCase; raw Supabase directory records use snake_case.
    const recipientUserId = recipient?.userId || recipient?.user_id;
    const recipientPublicKey = recipient?.publicKey || recipient?.public_key;
    if (!recipientUserId || !recipientPublicKey) throw new Error('Contact key not available');
    const ciphertext = await ProxiCrypto.encryptFor(recipientPublicKey, plaintext);
    const rows = await api('proxitalk_messages', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        sender_id: senderId,
        recipient_id: recipientUserId,
        ciphertext,
        packet_type: 'message',
      }),
    });
    const inserted = Array.isArray(rows) ? rows[0] : null;
    if (!inserted?.id) {
      throw new Error('The mailbox did not confirm saving this message (no message row ID returned).');
    }
    return inserted;
  }

  async function sendCallSignal(signal) {
    const rows = await api('proxitalk_call_signals', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ call_id: signal.callId, sender_id: signal.senderId,
        recipient_id: signal.recipientId, kind: signal.kind, ciphertext: signal.ciphertext }),
    });
    const inserted = Array.isArray(rows) ? rows[0] : null;
    if (!inserted?.id) throw new Error('The call signal was not accepted by the signaling mailbox.');
    return inserted;
  }
  async function receiveCallSignals(userId, since) {
    const uid = encodeURIComponent('eq.' + userId);
    const after = encodeURIComponent('gte.' + since);
    const now = encodeURIComponent('gt.' + new Date().toISOString());
    return api(`proxitalk_call_signals?recipient_id=${uid}&created_at=${after}&expires_at=${now}&select=id,call_id,sender_id,kind,ciphertext,created_at&order=created_at.asc&limit=100`);
  }
  async function deleteCallSignal(id) {
    return api(`proxitalk_call_signals?id=${encodeURIComponent('eq.' + id)}`, { method: 'DELETE' });
  }
  async function pruneCallSignals() {
    return api(`proxitalk_call_signals?expires_at=${encodeURIComponent('lt.' + new Date().toISOString())}`, { method: 'DELETE' });
  }

  async function receivePending(userId) {
    const uid = encodeURIComponent('eq.' + userId);
    const now = encodeURIComponent('gt.' + new Date().toISOString());
    const rows = await api(`proxitalk_messages?recipient_id=${uid}&delivered_at=is.null&expires_at=${now}&select=id,sender_id,ciphertext,packet_type,created_at&order=created_at.asc&limit=100`);
    const received = [];
    for (const row of rows || []) {
      try {
        const text = await ProxiCrypto.decryptFromMe(row.ciphertext);
        await api(`proxitalk_messages?id=${encodeURIComponent('eq.' + row.id)}&recipient_id=${uid}`, {
          method: 'PATCH', body: JSON.stringify({ delivered_at: new Date().toISOString() }),
        });
        received.push({ ...row, text });
      } catch (error) {
        console.warn('[ProxiCloud] skipped unreadable encrypted packet', row.id, error);
      }
    }
    return received;
  }

  return { findDirectoryById, findDirectoryByUserId, createDirectoryProfile, updateDirectorySigningKey,
    sendEncryptedMessage, receivePending, sendCallSignal, receiveCallSignals, deleteCallSignal, pruneCallSignals };
})();
