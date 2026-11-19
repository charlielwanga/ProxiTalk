/* ═══════════════════════════════════════════════════════════════
   ProxiTalk App — UI, chats, messages, media, SOS, settings
   ═══════════════════════════════════════════════════════════════ */
(async function () {
  'use strict';

  let authUser = await ProxiAuth.initialize();
  ProxiBLE.setIdentity(authUser?.id || '');
  Store.setNamespace(authUser?.id || '');
  let currentProfile = null;
  let offlineMode = !authUser && sessionStorage.getItem('proxitalk_continue_offline') === '1';
  if (authUser) {
    try { currentProfile = await ProxiCloud.findDirectoryByUserId(authUser.id); }
    catch (error) { console.warn('[ProxiTalk] profile lookup failed', error); }
  }
  let keyAvailable = !authUser || !currentProfile;
  let signingKeyAvailable = false;
  let signingKeyConflict = false;
  let initialChats = Store.load('chats', {});
  if (authUser && currentProfile) {
    try {
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      keyAvailable = publicKey.x === currentProfile.public_key.x && publicKey.y === currentProfile.public_key.y;
      if (keyAvailable) {
        const localSigningKey = ProxiCrypto.getSigningPublicKey();
        const remoteSigningKey = currentProfile.signing_public_key;
        if (!remoteSigningKey) {
          try {
            const updated = await ProxiCloud.updateDirectorySigningKey(authUser.id, localSigningKey);
            signingKeyAvailable = !!updated;
            if (updated) currentProfile = { ...currentProfile, signing_public_key: updated.signing_public_key || localSigningKey };
          } catch (error) { console.warn('[ProxiTalk] could not publish device signing key', error); }
        } else if (remoteSigningKey.kty === localSigningKey.kty && remoteSigningKey.crv === localSigningKey.crv
          && remoteSigningKey.x === localSigningKey.x && remoteSigningKey.y === localSigningKey.y) {
          signingKeyAvailable = true;
        } else {
          signingKeyConflict = true;
          console.error('[ProxiTalk] local signing key differs from the directory key; offline identity is disabled');
        }
        initialChats = await ProxiCrypto.decryptLocalData(initialChats);
      }
    } catch (error) { keyAvailable = false; console.warn('[ProxiTalk] device history key unavailable', error); }
  }

  // No seeded contacts, sample conversations, or fabricated message history.
  const localProfileId = currentProfile?.proxitalk_id || (() => {
    const bytes = crypto.getRandomValues(new Uint32Array(1))[0];
    const id = 'LOCAL-' + bytes.toString(16).padStart(8, '0').toUpperCase();
    Store.save('profile_id', id);
    return id;
  })();

  // ── State ──────────────────────────────────────────────────
  let contacts = Store.load('contacts', []);
  let chats = initialChats;                  // Device-local conversations, encrypted at rest for signed-in users
  if (!Array.isArray(contacts)) contacts = [];
  contacts = contacts.filter(c => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.name === 'string');
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) chats = {};
  chats = Object.fromEntries(Object.entries(chats)
    .filter(([id, messages]) => !['__proto__', 'constructor', 'prototype'].includes(id) && Array.isArray(messages))
    .map(([id, messages]) => [id, messages.filter(message => message && typeof message === 'object')]));
  let activeChat = null;
  let filter = 'all';
  let search = '';
  let replyTo = null;
  let mediaRecorder = null, mediaChunks = [], recording = false;

  // Remove known prototype fixtures and old synthetic inbound messages without
  // downgrading verified cloud messages from the authenticated mailbox.
  const legacyIds = new Set(['Amina', 'Brian', 'Cathy', 'David', 'Esther', 'Kampala Market Group', 'Emergency SOS Network']);
  const hadLegacyContacts = contacts.some(c => legacyIds.has(c.id));
  contacts = contacts.filter(c => !legacyIds.has(c.id));
  legacyIds.forEach(id => { delete chats[id]; });
  let migratedDrafts = false;
  for (const id of Object.keys(chats)) {
    const messages = Array.isArray(chats[id]) ? chats[id] : [];
    const retained = messages.filter(m => m.from === 'me' || (m.from === 'them' && m.cloudId && m.encrypted));
    if (retained.length !== messages.length) migratedDrafts = true;
    retained.forEach(m => {
      const confirmedCloudMessage = !!m.cloudId && m.encrypted && ['sent', 'received'].includes(m.status);
      if (confirmedCloudMessage) return;
      if (m.status !== 'local' || m.encrypted || m.hops || m.path || m.cipher) migratedDrafts = true;
      m.status = 'local'; m.encrypted = false; m.hops = 0;
      delete m.path; delete m.cipher;
    });
    chats[id] = retained;
  }
  let persistQueue = Promise.resolve();
  if (hadLegacyContacts || migratedDrafts) persist();

  function persist() {
    Store.save('contacts', contacts);
    if (authUser && currentProfile) {
      if (!keyAvailable) return;
      const snapshot = JSON.parse(JSON.stringify(chats));
      persistQueue = persistQueue.then(async () => {
        const encrypted = await ProxiCrypto.encryptLocalData(snapshot);
        Store.save('chats', encrypted);
      }).catch(error => console.error('[ProxiTalk] could not encrypt local chat history', error));
    } else {
      Store.save('chats', chats);
    }
  }

  function contactById(id) { return contacts.find(c => c.id === id); }
  function initials(name) { return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
  function fmtTime(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (Date.now() - ts < 864e5) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (new Date(now - 864e5).toDateString() === d.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#9A7939'; }
  function safeImageUrl(value) { return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(String(value || '')) ? value : ''; }
  function ticks(status) {
    if (status === 'read') return '<span class="ticks read">✓✓</span>';
    if (status === 'delivered') return '<span class="ticks">✓✓</span>';
    if (status === 'relayed') return '<span class="ticks">✓</span>';
    return '<span class="ticks">🕐</span>';
  }
  function previewOf(msg) {
    if (!msg) return 'No messages yet';
    if (msg.type === 'image') return '📷 Photo';
    if (msg.type === 'voice') return '🎤 Voice message';
    if (msg.type === 'file') return '📎 ' + (msg.fileName || 'File');
    if (msg.type === 'location') return '📍 Location';
    return (msg.from === 'me' ? '' : '') + (msg.text || '');
  }

  // ── DOM refs ───────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const chatListEl = $('chatList'), messagesEl = $('messages');

  function showProfileSetup(isExistingProfile = false, allowCancel = false) {
    $('authForm').classList.add('hidden');
    $('googleSignIn').classList.add('hidden');
    document.querySelector('.auth-divider').classList.add('hidden');
    $('continueOffline').classList.add('hidden');
    $('profileForm').classList.remove('hidden');
    $('profileName').value = currentProfile?.display_name || '';
    $('profilePhone').value = '';
    $('profileSubmit').textContent = isExistingProfile ? 'Update my ProxiTalk ID' : 'Create my ProxiTalk ID';
    $('profileCancel').classList.toggle('hidden', !allowCancel);
    $('authIntro').textContent = isExistingProfile
      ? 'Update your existing profile with a Uganda mobile number. Your ProxiTalk ID will change to that number.'
      : 'Create your ProxiTalk identity. Your Uganda mobile number will become your ProxiTalk ID.';
    $('authStatus').textContent = '';
  }

  async function finishSignIn() {
    const status = $('authStatus');
    try {
      authUser = await ProxiAuth.initialize();
      if (!authUser) throw new Error('Sign-in link was not accepted. Open the latest email link in this browser.');
      Store.setNamespace(authUser.id);
      currentProfile = await ProxiCloud.findDirectoryByUserId(authUser.id);
      if (!currentProfile) {
        showProfileSetup(false);
        return;
      }
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      if (publicKey.x !== currentProfile.public_key.x || publicKey.y !== currentProfile.public_key.y) {
        ProxiCrypto.clearMemory();
        throw new Error('This browser does not have the private key for this account. Messaging is paused to protect your encrypted messages.');
      }
      location.reload();
    } catch (error) {
      status.textContent = error.message || 'Could not finish sign-in.';
    }
  }

  $('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('authStatus');
    const button = $('authForm').querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Sending your secure sign-in link…';
    try {
      await ProxiAuth.sendMagicLink($('authEmail').value);
      status.textContent = 'Check your inbox and open the link in this browser. The link expires soon.';
    } catch (error) { status.textContent = error.message || 'Could not send the sign-in link.'; }
    finally { button.disabled = false; }
  });
  $('googleSignIn').addEventListener('click', async () => {
    const button = $('googleSignIn');
    const status = $('authStatus');
    button.disabled = true;
    status.textContent = 'Opening Google sign-in…';
    try { await ProxiAuth.signInWithGoogle(); }
    catch (error) {
      status.textContent = error.message || 'Could not start Google sign-in. Check that Google is enabled for this app.';
      button.disabled = false;
    }
  });
  $('continueOffline').addEventListener('click', () => {
    sessionStorage.setItem('proxitalk_continue_offline', '1');
    location.reload();
  });
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!authUser) return;
    const button = $('profileSubmit');
    button.disabled = true;
    try {
      const displayName = $('profileName').value.trim().replace(/\s+/g, ' ');
      if (!displayName || displayName.length > 48) throw new Error('Enter a display name of 1 to 48 characters.');
      const phoneId = ProxiIdentity.normalizeUgandaPhone($('profilePhone').value);
      if (!phoneId) throw new Error('Enter a Uganda mobile number like 0772 123 456 or +256 772 123 456.');
      if (currentProfile) {
        const updated = await ProxiCloud.updateDirectoryIdentity(authUser.id, phoneId, displayName);
        if (!updated) throw new Error('Your profile was not updated. Please try again.');
      } else {
        const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
        const signingPublicKey = ProxiCrypto.getSigningPublicKey();
        await ProxiCloud.createDirectoryProfile({
          userId: authUser.id, proxiId: phoneId, displayName, publicKey, signingPublicKey,
        });
      }
      sessionStorage.removeItem('proxitalk_continue_offline');
      location.reload();
    } catch (error) {
      $('authStatus').textContent = error.code === '23505'
        ? 'That phone number is already registered to a ProxiTalk account. Use another number or contact support.'
        : (error.message || 'Could not save your profile. Please try again.');
      button.disabled = false;
    }
  });
  $('profileCancel').onclick = () => $('authOverlay').classList.add('hidden');
  if (!authUser && ProxiAuth.getError()) $('authStatus').textContent = ProxiAuth.getError();
  if (authUser && currentProfile) {
    try {
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      if (keyAvailable && publicKey.x === currentProfile.public_key.x && publicKey.y === currentProfile.public_key.y) {
        if (ProxiIdentity.isProxiTalkId(currentProfile.proxitalk_id)) {
          $('authOverlay').classList.add('hidden');
          sessionStorage.removeItem('proxitalk_continue_offline');
        } else {
          showProfileSetup(true);
        }
      } else {
        $('authStatus').textContent = 'This browser does not have the private key for this account. Sign-in cannot recover it; use the original device/browser.';
        $('authForm').classList.add('hidden');
        $('continueOffline').classList.remove('hidden');
      }
    } catch (error) { $('authStatus').textContent = error.message; }
  } else if (authUser) {
    showProfileSetup(false);
  } else if (offlineMode) {
    $('authOverlay').classList.add('hidden');
  }
  if (authUser && !currentProfile && location.hash.includes('access_token=')) finishSignIn();

  // ── Render chat list ───────────────────────────────────────
  function renderChatList() {
    const items = contacts.map(c => {
      const msgs = chats[c.id] || [];
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter(m => m.from === 'them' && !m.seen && m.time > (c.lastRead || 0)).length;
      return { c, last, unread };
    }).filter(({ c }) => {
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())
        && !c.id.toLowerCase().includes(search.toLowerCase())
        && !String(c.proxiId || '').includes(search.replace(/\s+/g, ''))) return false;
      if (filter === 'unread') return true; // filtered below by unread
      if (filter === 'groups') return c.isGroup;
      return true;
    }).sort((a, b) => {
      if (filter === 'unread') return b.unread - a.unread;
      return (b.last?.time || 0) - (a.last?.time || 0);
    });

    let filtered = items;
    if (filter === 'unread') filtered = items.filter(i => i.unread > 0);

    if (filtered.length === 0) {
      chatListEl.innerHTML = '<p class="muted" style="padding:20px;text-align:center">No chats found.<br>Tap “＋ New Chat” to start one.</p>';
      return;
    }

    chatListEl.innerHTML = filtered.map(({ c, last, unread }) => `
      <div class="chat-item ${activeChat === c.id ? 'active' : ''}" data-id="${esc(c.id)}">
        <div class="avatar" style="background:${safeColor(c.color)}">${initials(c.name)}</div>
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">${esc(c.name)} ${c.isSOS ? '<span class="sos-tag">SOS</span>' : ''}</span>
            <span class="ci-time ${unread ? 'unread' : ''}">${last ? fmtTime(last.time) : ''}</span>
          </div>
          <div class="ci-bottom">
            <span class="ci-preview">${last && last.from === 'me' && last.status !== 'local' ? ticks(last.status) + ' ' : ''}${esc(previewOf(last))}</span>
            ${unread ? `<span class="ci-unread">${unread}</span>` : ''}
          </div>
        </div>
      </div>`).join('');

    chatListEl.querySelectorAll('.chat-item').forEach(el => {
      el.onclick = () => openChat(el.dataset.id);
    });

    const totalUnread = contacts.reduce((s, c) => s + (chats[c.id] || []).filter(m => m.from === 'them' && !m.seen).length, 0);
    $('unreadBadge').textContent = totalUnread;
    $('unreadBadge').style.display = totalUnread ? '' : 'none';
  }

  // ── Render messages ────────────────────────────────────────
  function renderMessages() {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msgs = chats[activeChat] || [];
    let html = '', lastDay = '';
    msgs.forEach(m => {
      const day = fmtDay(m.time);
      if (day !== lastDay) { html += `<div class="day-divider"><span>${day}</span></div>`; lastDay = day; }
      const isMe = m.from === 'me';
      const senderName = m.sender && !isMe ? `<div class="sender">${esc(m.sender)}</div>` : '';
      let body = '';
      if (m.type === 'image' && m.dataUrl) body = `<img class="msg-img" src="${esc(safeImageUrl(m.dataUrl))}" alt="photo">`;
      else if (m.type === 'voice') body = '<span class="text">Voice attachment unavailable in this preview</span>'; else if (m.type === 'file') {
        body = `<div class="file-chip"><span class="fic">📄</span><div><b>${esc(m.fileName || 'file')}</b><span>${esc(m.fileSize || '')} · local only</span></div></div>`;
      } else if (m.type === 'location') {
        body = `<div class="file-chip"><span class="fic">📍</span><div><b>${esc(m.text || 'Location')}</b><span>Local-only draft</span></div></div>`;
      } else {
        body = `<span class="text">${esc(m.text || '')}</span>`;
      }
      const replyHtml = m.replyTo ? `<div class="reply-quote"><b>${esc(m.replyTo.sender || 'You')}</b><span>${esc(m.replyTo.text || '')}</span></div>` : '';
      const reaction = m.reaction ? `<span class="reaction">${esc(m.reaction)}</span>` : '';
      const sosCls = m.isSOS ? ' sos-bubble' : '';
      const statusChip = m.status === 'local' ? '<span class="status-chip">Saved here · not sent</span>' : (m.status === 'failed' ? '<span class="status-chip">Delivery not confirmed · saved here</span>' : (m.status === 'sent' ? '<span class="status-chip">Encrypted · server queued</span>' : (m.status === 'ble_queued' ? '<span class="status-chip">Signed · queued for BLE · receipt unconfirmed</span>' : (m.status === 'ble_delivered' ? '<span class="status-chip">Recipient device confirmed · not read</span>' : (m.signerVerified ? '<span class="status-chip">BLE signature verified</span>' : '')))));
      html += `
        <div class="msg-row ${isMe ? 'me' : 'them'}">
          <div class="bubble${sosCls}" data-mid="${esc(m.id)}">
            ${senderName}${replyHtml}${body}
            <div class="meta">
              ${m.encrypted ? '<span class="enc">🔒</span>' : ''}
              ${m.hops ? `<span class="hop">${m.hops} hop${m.hops > 1 ? 's' : ''}</span>` : ''}
              <span>${fmtTime(m.time)}</span>
              ${isMe ? ticks(m.status) : ''}
              ${statusChip}
            </div>
            ${reaction}
          </div>
        </div>`;
    });
    messagesEl.innerHTML = html || '<p class="muted" style="text-align:center;padding:30px">No messages yet. Say hello! 👋</p>';
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Bubble interactions: click = react, double-click = reply
    messagesEl.querySelectorAll('.bubble').forEach(b => {
      b.onclick = () => {
        const mid = b.dataset.mid;
        const msg = (chats[activeChat] || []).find(m => m.id === mid);
        if (!msg) return;
        const emojis = ['❤️', '😂', '👍', '😮', '🙏'];
        const next = emojis[(emojis.indexOf(msg.reaction) + 1) % emojis.length];
        msg.reaction = msg.reaction === next ? null : next;
        persist(); renderMessages();
      };
      b.ondblclick = () => {
        const mid = b.dataset.mid;
        const msg = (chats[activeChat] || []).find(m => m.id === mid);
        if (!msg) return;
        replyTo = { sender: msg.from === 'me' ? 'You' : (msg.sender || contactById(activeChat)?.name || 'Them'), text: msg.text || previewOf(msg) };
        $('msgInput').placeholder = 'Reply to: ' + replyTo.text.slice(0, 40) + '…';
        $('msgInput').focus();
      };
    });
    messagesEl.querySelectorAll('[data-play]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        btn.textContent = btn.textContent === '▶' ? '⏸' : '▶';
        setTimeout(() => { btn.textContent = '▶'; }, 1500);
      };
    });
  }

  // ── Open chat ──────────────────────────────────────────────
  function openChat(id) {
    activeChat = id;
    const c = contactById(id);
    if (!c) return;
    // Mark read
    (chats[id] || []).forEach(m => { if (m.from === 'them') m.seen = true; });
    persist();
    $('chatEmpty').classList.add('hidden');
    $('chatView').classList.remove('hidden');
    $('chatAvatar').textContent = initials(c.name);
    $('chatAvatar').style.background = c.color;
    $('chatName').textContent = c.name;
    updateChatStatus();
    renderChatList();
    renderMessages();
    if (window.innerWidth <= 760) {
      $('sidebar').classList.add('hide-mobile');
      $('chatArea').classList.add('show-mobile');
    }
  }

  function updateChatStatus() {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msgs = chats[activeChat] || [];
    const last = msgs[msgs.length - 1];
    $('chatStatus').textContent = offlineMode ? 'Local drafts only · not sent' : (last?.status === 'local' ? 'Saved on this device · not sent' : (last?.status === 'failed' ? 'Delivery not confirmed · message saved locally' : (last?.status === 'ble_queued' ? 'Signed, queued for nearby devices · receipt unconfirmed' : (last?.status === 'ble_delivered' ? 'Recipient device confirmed · not read' : (c?.proxiId ? 'Encrypted online messaging' : 'Choose a verified ProxiTalk ID')))));
    $('hopBadge').textContent = last?.status === 'sent' ? 'server queued' : (last?.status === 'ble_queued' ? 'BLE handoff' : 'no mesh');
  }

  async function trySendSignedBleMessage(contact, text) {
    if (ProxiBLE.detect() !== 'native-discovery' || !ProxiBLE.getStatus().running
      || !authUser || !currentProfile || !keyAvailable || !signingKeyAvailable || signingKeyConflict
      || !contact?.userId || !contact?.publicKey) return false;
    const createdAt = Date.now();
    const packet = await ProxiCrypto.signPacket({
      v: 1,
      id: crypto.randomUUID(),
      sender_id: authUser.id,
      recipient_id: contact.userId,
      created_at: createdAt,
      expires_at: createdAt + 7 * 24 * 60 * 60 * 1000,
      hops: 0,
      ciphertext: await ProxiCrypto.encryptFor(contact.publicKey, JSON.stringify({ type: 'text', text })),
    });
    const result = ProxiBLE.sendPacket(packet);
    if (!result?.ok) throw new Error(result?.error || 'Nearby BLE carrier could not store the encrypted packet');
    return packet.id;
  }

  async function sendBleAcknowledgement(contact, originalPacketId) {
    if (!authUser || !signingKeyAvailable || !contact?.userId || !contact?.publicKey) return false;
    const createdAt = Date.now();
    const packet = await ProxiCrypto.signPacket({
      v: 1, id: crypto.randomUUID(), sender_id: authUser.id, recipient_id: contact.userId,
      created_at: createdAt, expires_at: createdAt + 24 * 60 * 60 * 1000, hops: 0,
      ciphertext: await ProxiCrypto.encryptFor(contact.publicKey,
        JSON.stringify({ type: 'delivered_ack', packet_id: originalPacketId })),
    });
    const result = ProxiBLE.sendPacket(packet);
    return !!result?.ok;
  }

  // ── Send message ───────────────────────────────────────────
  async function sendMessage(text, opts = {}) {
    if (!activeChat) return;
    const c = contactById(activeChat);
    if (!c) return;
    const msg = {
      id: 'm_' + crypto.randomUUID(),
      from: 'me', toName: c.id, recipientUserId: c.userId || null, text,
      type: opts.type || 'text',
      dataUrl: opts.dataUrl || null,
      fileName: opts.fileName || null, fileSize: opts.fileSize || null,
      duration: opts.duration || null,
      time: Date.now(), status: 'local', hops: 0, encrypted: false,
      isSOS: opts.isSOS || false,
      replyTo: replyTo ? { ...replyTo } : null,
    };
    replyTo = null;
    $('msgInput').placeholder = offlineMode ? 'Write a local draft (not sent)…' : 'Write a message…';
    (chats[activeChat] = chats[activeChat] || []).push(msg);
    persist();
    renderMessages(); renderChatList(); updateChatStatus();

    if (offlineMode || !authUser || !currentProfile) {
      toast('Saved on this device only — not sent');
      return;
    }
    if (!c.proxiId || !c.userId || !c.publicKey) {
      toast('This contact is not verified. Add their ProxiTalk ID before sending.');
      return;
    }
    if (msg.type !== 'text') {
      toast('Online delivery currently supports text only. This attachment remains a local draft.');
      return;
    }
    try {
      const savedRow = await ProxiCloud.sendEncryptedMessage(authUser.id, c, text);
      msg.status = 'sent'; msg.encrypted = true; msg.cloudId = savedRow.id;
      persist(); renderMessages(); renderChatList(); updateChatStatus();
      toast('Encrypted and saved to the server mailbox');
    } catch (error) {
      console.warn('[ProxiTalk] online message delivery was not confirmed', error);
      try {
        const packetId = await trySendSignedBleMessage(c, text);
        if (packetId) {
          msg.status = 'ble_queued'; msg.encrypted = true; msg.blePacketId = packetId; msg.signerVerified = true;
          persist(); renderMessages(); renderChatList(); updateChatStatus();
          toast('Encrypted message stored in the nearby queue. Recipient decryption is not confirmed.');
          return;
        }
      } catch (bleError) { console.warn('[ProxiTalk] signed BLE handoff failed', bleError); }
      msg.status = 'failed'; msg.failureMessage = error.message || 'Network error';
      persist(); renderMessages(); renderChatList(); updateChatStatus();
      const code = error.code ? ' [' + error.code + ']' : (error.status ? ' [HTTP ' + error.status + ']' : '');
      toast('Delivery not confirmed' + code + ': ' + msg.failureMessage + '. Saved locally.');
    }
  }

  async function pollInbox() {
    if (!authUser || !currentProfile || !ProxiAuth.isSignedIn()) return;
    try {
      const incoming = await ProxiCloud.receivePending(authUser.id);
      for (const row of incoming) {
        let contact = contacts.find(item => item.userId === row.sender_id);
        if (!contact) {
          const remote = await ProxiCloud.findDirectoryByUserId(row.sender_id);
          if (!remote) continue;
          contact = { id: remote.proxitalk_id, proxiId: remote.proxitalk_id, userId: remote.user_id, publicKey: remote.public_key, signingPublicKey: remote.signing_public_key || null, name: remote.display_name, color: '#9A7939', about: 'Verified ProxiTalk contact', phone: remote.proxitalk_id };
          contacts.push(contact);
        }
        const list = chats[contact.id] || (chats[contact.id] = []);
        if (list.some(message => message.cloudId === row.id)) continue;
        list.push({ id: row.id, cloudId: row.id, from: 'them', sender: contact.name, text: row.text, type: 'text', time: Date.parse(row.created_at) || Date.now(), status: 'received', encrypted: true, hops: 0 });
        if (!activeChat || activeChat !== contact.id) {
          contact.lastRead = 0;
        }
      }
      if (incoming.length) { persist(); renderChatList(); if (activeChat) renderMessages(); }
    } catch (error) { console.warn('[ProxiTalk] inbox poll failed', error); }
  }

  let blePollRunning = false;
  async function pollBlePackets() {
    if (blePollRunning || !authUser || !currentProfile || !keyAvailable || !signingKeyAvailable || signingKeyConflict) return;
    blePollRunning = true;
    try {
      for (const packet of ProxiBLE.drainPackets()) {
        if (!packet || typeof packet.id !== 'string') continue;
        let keepForRetry = false;
        try {
          const now = Date.now();
          const routeHops = packet.route_hops ?? 0;
          if (packet.v !== 1 || packet.recipient_id !== authUser.id
            || !Number.isFinite(packet.created_at) || !Number.isFinite(packet.expires_at)
            || packet.created_at > now + 60_000 || packet.expires_at <= now
            || packet.expires_at <= packet.created_at || packet.expires_at > packet.created_at + 14 * 24 * 60 * 60 * 1000
            || packet.hops !== 0 || !Number.isInteger(routeHops) || routeHops < 0 || routeHops > 3) {
            ProxiBLE.acknowledgePacket(packet.id); continue;
          }
          let contact = contacts.find(item => item.userId === packet.sender_id);
          if (!contact) {
            const remote = await ProxiCloud.findDirectoryByUserId(packet.sender_id);
            if (!remote) { keepForRetry = true; continue; }
            contact = { id: remote.proxitalk_id, proxiId: remote.proxitalk_id, userId: remote.user_id,
              publicKey: remote.public_key, signingPublicKey: remote.signing_public_key || null,
              name: remote.display_name, color: '#9A7939', about: 'Verified ProxiTalk contact', phone: remote.proxitalk_id };
            contacts.push(contact);
          } else if (!contact.signingPublicKey) {
            const remote = await ProxiCloud.findDirectoryByUserId(packet.sender_id);
            if (remote) contact.signingPublicKey = remote.signing_public_key || null;
          }
          if (!contact.signingPublicKey) { keepForRetry = true; continue; }
          if (!await ProxiCrypto.verifyPacket(packet, contact.signingPublicKey)) {
            ProxiBLE.acknowledgePacket(packet.id); continue;
          }
          const decoded = JSON.parse(await ProxiCrypto.decryptFromMe(packet.ciphertext));
          if (decoded?.type === 'delivered_ack') {
            if (typeof decoded.packet_id === 'string' && decoded.packet_id.length <= 80) {
              let changed = false;
              for (const [chatId, list] of Object.entries(chats)) {
                const sent = list.find(message => message.blePacketId === decoded.packet_id && message.from === 'me');
                const expectedRecipient = sent?.recipientUserId || contactById(chatId)?.userId;
                if (sent && expectedRecipient === packet.sender_id && sent.status === 'ble_queued') {
                  sent.status = 'ble_delivered'; sent.bleHops = routeHops; changed = true;
                }
              }
              if (changed) { persist(); renderChatList(); if (activeChat) renderMessages(); updateChatStatus(); }
              ProxiBLE.acknowledgePacket(packet.id);
            } else ProxiBLE.acknowledgePacket(packet.id);
            continue;
          }
          if (!decoded || decoded.type !== 'text' || typeof decoded.text !== 'string' || decoded.text.length > 4096) {
            ProxiBLE.acknowledgePacket(packet.id); continue;
          }
          const list = chats[contact.id] || (chats[contact.id] = []);
          const duplicate = list.some(message => message.blePacketId === packet.id || message.cloudId === packet.id);
          if (!duplicate) {
            list.push({ id: packet.id, blePacketId: packet.id, from: 'them', sender: contact.name,
              text: decoded.text, type: 'text', time: packet.created_at, status: 'received',
              encrypted: true, signerVerified: true, hops: routeHops });
            if (!activeChat || activeChat !== contact.id) contact.lastRead = 0;
            persist(); renderChatList(); if (activeChat) renderMessages();
          }
          // Receipt means authenticated recipient decryption, not that the person read it.
          const queuedReceipt = await sendBleAcknowledgement(contact, packet.id).catch(error => {
            console.warn('[ProxiTalk] could not queue BLE delivery receipt', error); return false;
          });
          if (queuedReceipt) {
            ProxiBLE.acknowledgePacket(packet.id);
            if (!duplicate) toast(`Encrypted nearby message received via ${routeHops} relay hop${routeHops === 1 ? '' : 's'}.`);
          } else keepForRetry = true;
        } catch (error) {
          console.warn('[ProxiTalk] ignored an invalid BLE packet', error);
          ProxiBLE.acknowledgePacket(packet.id);
        }
        if (keepForRetry) continue;
      }
    } finally { blePollRunning = false; }
  }

  // ── Mesh callbacks ─────────────────────────────────────────
  function onMeshDeliver(msg, kind) {
    // Find local message and update status
    Object.keys(chats).forEach(cid => {
      const local = (chats[cid] || []).find(m => m.id === msg.id);
      if (local) {
        if (kind === 'delivered') { local.status = 'delivered'; local.hops = msg.hops || local.hops; }
        if (kind === 'ack') { local.status = 'read'; }
        persist();
        if (activeChat === cid) { renderMessages(); updateChatStatus(); }
        renderChatList();
      }
    });
  }

  function onMeshStats({ stats, queue, syncLog, nodes, internetOnline: online }) {
    const st = MeshEngine.getStats();
    $('meshPillText').textContent = 'No live transport';
    $('queueCount').textContent = queue.length + ' transport packets';
    $('footNodes').textContent = nodes.length + 1;
    $('footDelivered').textContent = st.delivered;
    $('footHops').textContent = st.avgHops;
    $('footSaved').textContent = Object.values(chats).reduce((n, list) => n + list.filter(m => m.status === 'local').length, 0);
    $('stNodes').textContent = nodes.length + 1;
    $('stDelivered').textContent = st.delivered;
    $('stHops').textContent = st.avgHops;
    $('stQueued').textContent = queue.length;
    $('stSynced').textContent = st.synced;
    $('stRange').textContent = '—';

    // Queue list
    const ql = $('queueList');
    if (queue.length === 0) ql.innerHTML = '<p class="muted">No transport queue. Drafts are stored locally and are not sent.</p>';
    else ql.innerHTML = queue.slice(0, 6).map(m => `
      <div class="queue-item"><span class="q-ico">📦</span><div><b>${esc((m.text || m.fileName || 'media').slice(0, 30))}</b><span>→ ${esc(m.toName)} · ${m.hops || 0} hops · TTL ${m.ttl ?? '—'}</span></div></div>`).join('');

    // Sync log
    const sl = $('syncLog');
    sl.innerHTML = syncLog.length ? syncLog.map(s => `<div class="sync-item"><span class="s-ico">☁️</span><div><b>${esc(s.text)}</b><span>${esc(s.time)}</span></div></div>`).join('') : '<p class="muted">The online mailbox is separate from this local mesh panel. Bluetooth mesh is not connected.</p>';

    // Node list
    $('nodeList').innerHTML = nodes.length ? nodes.map(n => `
      <div class="node-item"><span class="n-dot" style="background:${n.color}"></span>
        <div class="n-info"><b>${esc(n.name)} ${n.isGateway ? '☁️' : ''}</b><span>${n.isGateway ? 'Gateway node' : 'Peer node'} · relay ${n.battery}%</span></div>
        <span class="n-batt">🔋 ${n.battery}%</span></div>`).join('') : '<p class="muted">No live peers detected. Bluetooth mesh transport is not available in this web build.</p>';

    updateChatStatus();
  }

  // ── Toast ──────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  // ── Modal helpers ──────────────────────────────────────────
  function openModal(title, bodyHtml) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalOverlay').classList.remove('hidden');
  }
  function closeModal() { $('modalOverlay').classList.add('hidden'); }
  $('modalClose').onclick = closeModal;
  $('modalOverlay').onclick = e => { if (e.target === $('modalOverlay')) closeModal(); };

  // ── New chat / group ───────────────────────────────────────
  $('newChatBtn').onclick = () => {
    const rows = contacts.filter(c => c.proxiId).map(c => `
      <div class="contact-row" data-id="${esc(c.id)}">
        <div class="avatar" style="background:${safeColor(c.color)}">${initials(c.name)}</div>
        <div><b>${esc(c.name)}</b><span>ProxiTalk phone ID · ${esc(c.proxiId)}</span></div>
        <span class="sel">›</span>
      </div>`).join('');
    openModal('New encrypted chat', `${rows || '<p class="muted">No contacts yet. Add someone using their ProxiTalk phone ID.</p>'}<div class="field" style="margin-top:14px"><label for="newIdInput">Contact phone / ProxiTalk ID</label><input id="newIdInput" type="tel" inputmode="tel" maxlength="22" placeholder="2567xxxxxxxx"><small class="muted">Enter the Uganda mobile number they use as their ID. Confirm key fingerprints out of band for sensitive conversations.</small><button class="btn-primary" id="newIdGo" style="margin-top:8px">Find and add contact</button></div>`);
    $('modalBody').querySelectorAll('.contact-row').forEach(r => r.onclick = () => { closeModal(); openChat(r.dataset.id); });
    $('newIdGo').onclick = async () => {
      const id = ProxiIdentity.normalizeUgandaPhone($('newIdInput').value);
      if (!id) return toast('Enter a Uganda mobile ID like 0772 123 456 or 256772123456.');
      if (!authUser || offlineMode) return toast('Sign in to look up verified online contacts');
      try {
        const remote = await ProxiCloud.findDirectoryById(id);
        if (!remote) return toast('No account found for that ProxiTalk ID');
        if (remote.user_id === authUser.id) return toast('That is your own ProxiTalk ID');
        let c = contacts.find(item => item.userId === remote.user_id);
        if (!c) {
          c = { id: remote.proxitalk_id, proxiId: remote.proxitalk_id, userId: remote.user_id, publicKey: remote.public_key, signingPublicKey: remote.signing_public_key || null, name: remote.display_name, color: '#9A7939', phone: remote.proxitalk_id, about: 'Verified ProxiTalk contact' };
          contacts.push(c); persist(); renderChatList();
        } else {
          let changed = false;
          if (c.proxiId !== remote.proxitalk_id) { c.proxiId = remote.proxitalk_id; changed = true; }
          if (c.phone !== remote.proxitalk_id) { c.phone = remote.proxitalk_id; changed = true; }
          if (remote.signing_public_key && JSON.stringify(c.signingPublicKey) !== JSON.stringify(remote.signing_public_key)) {
            c.signingPublicKey = remote.signing_public_key; changed = true;
          }
          if (changed) { persist(); renderChatList(); }
        }
        closeModal(); openChat(c.id);
      } catch (error) { toast(error.message || 'Could not search the directory'); }
    };
  };

  $('newGroupBtn').onclick = () => toast('Encrypted group messaging is not available yet. Only one-to-one text messages are supported.');

  // ── Settings ───────────────────────────────────────────────
  $('settingsBtn').onclick = async () => {
    const fingerprint = currentProfile ? await ProxiCrypto.fingerprint(currentProfile.public_key) : 'Local drafts only';
    const signingFingerprint = authUser ? await ProxiCrypto.fingerprint(ProxiCrypto.getSigningPublicKey()) : 'Not provisioned';
    openModal('Account & security', `
      <div class="detail-row"><span>${currentProfile ? 'Your ProxiTalk phone ID' : 'Local draft ID · not registered'}</span><b>${esc(currentProfile?.proxitalk_id || localProfileId)}</b></div>
      ${currentProfile ? `<div class="detail-row"><span>Encryption-key fingerprint</span><b>${esc(fingerprint)}</b></div><div class="detail-row"><span>Signing-key fingerprint</span><b>${esc(signingFingerprint)}</b></div><div class="detail-row"><span>Offline sender identity</span><b>${signingKeyConflict ? 'Key mismatch · disabled' : signingKeyAvailable ? 'Provisioned on this device' : 'Not synchronized'}</b></div><button class="btn-primary" id="copyIdBtn" style="margin:8px 0">Copy my ProxiTalk ID</button><button class="mini-btn" id="changePhoneIdBtn" style="width:100%;margin:0 0 8px">Change my phone-based ID</button>` : ''}
      <div class="detail-row"><span>Account</span><b>${authUser ? esc(authUser.email || 'Signed in') : 'Not signed in'}</b></div>
      <div class="detail-row"><span>Message security</span><b>Recipient public-key encryption for online text</b></div>
      <div class="detail-row"><span>Delivery</span><b>${offlineMode || !authUser ? 'Local drafts only; not sent' : 'Internet mailbox; experimental BLE handoff if online send fails'}</b></div>
      <div class="detail-row"><span>Device storage</span><b>Private key is device-bound; no key recovery</b></div>
      <p style="font-size:12px;color:var(--muted);margin-top:12px;line-height:1.6">Your ProxiTalk ID is your phone number and is visible to signed-in directory users; avoid sharing it publicly. Phone ownership is not SMS-verified in this beta. Compare both key fingerprints with your contact out of band to detect directory key changes. The signing key authenticates experimental Android BLE text against the online directory. Relay is opt-in and capped at three hops; a signed receipt confirms recipient-device decryption, not that a person read the message. Physical-device behavior is not yet validated. New devices cannot decrypt old messages. Attachments, groups, SMS, call push notifications, and emergency SOS are not supported. Calls are beta and require a direct network route; do not rely on ProxiTalk for emergencies.</p>
      ${authUser ? '<button class="btn-primary" id="signOutBtn" style="margin-top:12px">Sign out</button>' : ''}
      <button class="btn-primary" id="wipeBtn" style="margin-top:12px;background:#3D1A20;color:#FF8A96">Clear local chat data</button>`);
    if (currentProfile) $('copyIdBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(currentProfile.proxitalk_id); toast('ProxiTalk ID copied. Verify fingerprints out of band before sensitive chats.'); }
      catch (_) { toast('Your ProxiTalk ID is ' + currentProfile.proxitalk_id); }
    };
    if (currentProfile) $('changePhoneIdBtn').onclick = () => {
      closeModal();
      showProfileSetup(true, true);
      $('authOverlay').classList.remove('hidden');
    };
    $('wipeBtn').onclick = () => { Store.setNamespace(authUser?.id || ''); localStorage.removeItem('proxitalk_' + (authUser?.id ? authUser.id + '_' : '') + 'contacts'); localStorage.removeItem('proxitalk_' + (authUser?.id ? authUser.id + '_' : '') + 'chats'); location.reload(); };
    if (authUser) $('signOutBtn').onclick = async () => { ProxiCalls.stop(); ProxiBLE.setIdentity(''); ProxiBLE.stopScan(); await ProxiAuth.signOut(); ProxiCrypto.clearMemory(); sessionStorage.removeItem('proxitalk_continue_offline'); location.reload(); };
  };

  // ── Chat info (hop path) ───────────────────────────────────
  $('infoBtn').onclick = async () => {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msgs = chats[activeChat] || [];
    const last = msgs[msgs.length - 1];
    const path = ['This device'];
    const fingerprint = c.publicKey ? await ProxiCrypto.fingerprint(c.publicKey) : 'Not verified';
    const signingFingerprint = c.signingPublicKey ? await ProxiCrypto.fingerprint(c.signingPublicKey) : 'Not provisioned';
    openModal('Chat Info', `
      <div class="detail-row"><span>Name</span><b>${esc(c.name)}</b></div>
      <div class="detail-row"><span>About</span><b>${esc(c.about || '—')}</b></div>
      <div class="detail-row"><span>Phone / ID</span><b>${esc(c.phone || c.id)}</b></div>
      <div class="detail-row"><span>Encryption-key fingerprint</span><b>${esc(fingerprint)}</b></div>
      <div class="detail-row"><span>Signing-key fingerprint</span><b>${esc(signingFingerprint)}</b></div>
      <div class="detail-row"><span>Message privacy</span><b>Recipient-key encrypted online text</b></div>
      <div class="detail-row"><span>Delivery</span><b>${last?.status === 'local' ? 'Local draft · not sent' : last?.status === 'sent' ? 'Accepted by encrypted mailbox' : last?.status === 'ble_queued' ? 'Signed BLE handoff · receipt unconfirmed' : last?.signerVerified ? 'BLE sender signature verified' : 'No message sent'}</b></div>
      <h4 style="margin-top:14px;font-size:12px;color:var(--muted)">LAST MESSAGE PATH</h4>
      <div class="hop-path">${path.map((p, i) => `${i ? '<span class="hop-arrow">→</span>' : ''}<span class="hop-node">${esc(p)}</span>`).join('')}</div>
      <p style="font-size:12px;color:var(--muted)">No Bluetooth hop path exists in this local-only preview.</p>`);
  };

  // ── One-to-one WebRTC calls ─────────────────────────────────
  let callUiTimer = null;
  function attachCallMedia(element, stream) {
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) element.play().catch(() => {});
  }
  function renderCallState(event) {
    const overlay = $('callOverlay');
    const current = event.call;
    if (event.state === 'idle') { overlay.classList.add('hidden'); return; }
    overlay.classList.remove('hidden');
    clearTimeout(callUiTimer);
    if (event.state === 'ended') {
      $('callTitle').textContent = 'Call finished';
      $('callStatus').textContent = event.message || 'Call ended.';
      $('callModeLabel').textContent = '';
      ['callMuteBtn', 'callVideoBtn', 'callRejectBtn', 'callAcceptBtn', 'callEndBtn'].forEach(id => $(id).classList.add('hidden'));
      callUiTimer = setTimeout(() => overlay.classList.add('hidden'), 2400);
      return;
    }
    if (!current) return;
    $('callTitle').textContent = current.contact?.name || 'ProxiTalk call';
    $('callAvatar').textContent = initials(current.contact?.name || 'PT');
    $('callModeLabel').textContent = current.mode === 'video' ? 'Video call · peer-to-peer encrypted media' : 'Voice call · peer-to-peer encrypted media';
    const labels = { incoming: 'Incoming call · answer only if you recognize this contact.', preparing: 'Requesting microphone' + (current.mode === 'video' ? ' and camera' : '') + ' access…', outgoing: 'Calling · waiting for an answer…', connecting: 'Connecting directly…', active: 'Connected · peer-to-peer', failed: 'Could not connect. This network may require a TURN relay, which is not configured.' };
    $('callStatus').textContent = labels[event.state] || 'Call is setting up…';
    const incoming = event.state === 'incoming';
    const active = event.state === 'active';
    const controls = ['callMuteBtn', 'callVideoBtn', 'callRejectBtn', 'callAcceptBtn', 'callEndBtn'];
    controls.forEach(id => $(id).classList.add('hidden'));
    if (incoming) { $('callRejectBtn').classList.remove('hidden'); $('callAcceptBtn').classList.remove('hidden'); }
    else {
      $('callEndBtn').classList.remove('hidden');
      if (event.state === 'active' || current.direction === 'outgoing' || event.state === 'preparing' || event.state === 'connecting' || event.state === 'failed') $('callMuteBtn').classList.remove('hidden');
      if (current.mode === 'video' && event.state !== 'failed') $('callVideoBtn').classList.remove('hidden');
    }
    $('callMuteBtn').textContent = current.muted ? '🔇' : '🎙️';
    $('callMuteBtn').title = current.muted ? 'Unmute microphone' : 'Mute microphone';
    $('callVideoBtn').textContent = current.videoEnabled ? '📹' : '🚫';
    $('callVideoStage').classList.toggle('hidden', current.mode !== 'video');
    $('callAvatar').classList.toggle('hidden', current.mode === 'video');
  }
  ProxiCalls.setCallbacks({
    onStateChange: renderCallState,
    onIncoming: ({ contact }) => toast('Incoming call from ' + (contact?.name || 'a saved contact')),
    onLocalStream: (stream, mode) => { attachCallMedia($('callLocalVideo'), stream); $('callLocalVideo').classList.toggle('hidden', !stream || mode !== 'video'); },
    onRemoteStream: (stream, mode) => {
      attachCallMedia($('callRemoteVideo'), mode === 'video' ? stream : null);
      attachCallMedia($('callRemoteAudio'), mode === 'audio' ? stream : null);
    },
  });
  $('callBtn').onclick = () => {
    const contact = contactById(activeChat);
    if (!contact) return toast('Open a saved contact chat before starting a call.');
    if (!authUser || !currentProfile || !keyAvailable || !signingKeyAvailable || offlineMode) return toast('Sign in, unlock this device’s keys, and sync your signing key before calling.');
    if (!contact.userId || !contact.publicKey) return toast('This contact is missing their call encryption key.');
    openModal('Start a secure call', `<p class="muted">Call ${esc(contact.name)} using a direct internet connection. Both people must have ProxiTalk open; some networks may block direct calls.</p><button class="btn-primary" id="startAudioCall" style="margin-top:12px">📞 Start voice call</button><button class="btn-primary" id="startVideoCall" style="margin-top:8px">📹 Start video call</button>`);
    async function begin(mode) {
      closeModal();
      try { await ProxiCalls.start(contact, mode); }
      catch (error) { toast(error.message || 'Could not start the call. Check microphone/camera permissions.'); }
    }
    $('startAudioCall').onclick = () => begin('audio');
    $('startVideoCall').onclick = () => begin('video');
  };
  $('callAcceptBtn').onclick = async () => { try { await ProxiCalls.accept(); } catch (error) { toast(error.message || 'Could not answer call.'); } };
  $('callRejectBtn').onclick = () => ProxiCalls.decline();
  $('callEndBtn').onclick = () => ProxiCalls.end();
  $('callMuteBtn').onclick = () => { const muted = ProxiCalls.toggleMute(); if (typeof muted !== 'boolean') toast('Microphone is not active yet.'); };
  $('callVideoBtn').onclick = () => { const enabled = ProxiCalls.toggleVideo(); if (typeof enabled !== 'boolean') toast('Camera is not active yet.'); };

  // ── Composer ───────────────────────────────────────────────
  const input = $('msgInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  $('sendBtn').onclick = doSend;
  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 4096) return toast('Messages must be 4,096 characters or fewer.');
    input.value = ''; input.style.height = 'auto';
    sendMessage(text);
  }

  // Emoji picker
  const EMOJIS = ['😀','😂','😍','😎','🤔','😢','😡','👍','👎','🙏','🔥','❤️','🎉','✅','📶','📡','☁️','🆘','🍅','🍌','⚽','🎵','🌧️','☀️','🌙','⭐','💯','🙌','👏','🤝','💪','🧡'];
  $('emojiBtn').onclick = () => {
    const p = $('emojiPicker');
    p.classList.toggle('hidden');
    p.innerHTML = EMOJIS.map(e => `<button data-e="${e}">${e}</button>`).join('');
    p.querySelectorAll('button').forEach(b => b.onclick = () => { input.value += b.dataset.e; input.focus(); });
  };
  document.addEventListener('click', e => {
    if (!$('emojiPicker').contains(e.target) && e.target.id !== 'emojiBtn') $('emojiPicker').classList.add('hidden');
  });

  // Attach / media
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file || !activeChat) return;
    const isImage = file.type.startsWith('image/');
    const sizeKb = (file.size / 1024).toFixed(0);
    if (isImage) {
      const reader = new FileReader();
      reader.onload = () => sendMessage('📷 Photo (' + sizeKb + ' KB, local preview only)', { type: 'image', dataUrl: reader.result, fileName: file.name, fileSize: sizeKb + ' KB' });
      reader.readAsDataURL(file);
    } else {
      sendMessage('📎 ' + file.name + ' (' + sizeKb + ' KB)', { type: 'file', fileName: file.name, fileSize: sizeKb + ' KB' });
    }
    e.target.value = '';
  };

  // Voice-message transport is not implemented in this preview.
  $('micBtn').onclick = () => toast('Voice messages are not available until message transport is implemented.');

  // ── Panel / search / filters / back ────────────────────────
  function refreshBleUI() {
    const native = ProxiBLE.detect() === 'native-discovery';
    const status = ProxiBLE.getStatus();
    const start = $('bleStartBtn'), stop = $('bleStopBtn'), label = $('bleStatus');
    const relayStart = $('bleRelayStartBtn'), relayStop = $('bleRelayStopBtn');
    start.disabled = !native;
    start.classList.toggle('hidden', !!status.running);
    stop.classList.toggle('hidden', !status.running);
    relayStart.classList.toggle('hidden', !native || !status.running || !!status.relayEnabled);
    relayStop.classList.toggle('hidden', !native || !status.running || !status.relayEnabled);
    if (!native) label.textContent = 'Native BLE transport is available only in the Android app.';
    else if (status.error) label.textContent = status.error;
    else if (status.running) label.textContent = `Nearby BLE on · ${status.peerCount || 0} nearby · ${status.connectedPeerCount || 0} connected · ${status.queuedPacketCount || 0} stored packets · relay ${status.relayEnabled ? 'ON (3-hop cap)' : 'off'}. A recipient receipt means decrypted, not read.`;
    else label.textContent = 'Nearby BLE is off. Stored packets remain encrypted on this device until expiry.';
  }
  $('bleStartBtn').onclick = async () => {
    const result = await ProxiBLE.startScan();
    if (!result.ok) return toast(result.error || 'Could not start BLE discovery');
    toast('Nearby transport starting. Approve Android Bluetooth permissions if asked.');
    refreshBleUI();
  };
  $('bleStopBtn').onclick = () => {
    ProxiBLE.stopScan();
    toast('Nearby transport stopped; encrypted queued packets remain stored until expiry.');
    refreshBleUI();
  };
  $('bleRelayStartBtn').onclick = () => {
    const result = ProxiBLE.setRelayEnabled(true);
    if (!result.ok) return toast(result.error || 'Could not enable encrypted relay');
    toast('Encrypted relay enabled: this device may forward opaque packets up to 3 hops.');
    refreshBleUI();
  };
  $('bleRelayStopBtn').onclick = () => {
    const result = ProxiBLE.setRelayEnabled(false);
    if (!result.ok) return toast(result.error || 'Could not disable relay');
    toast('Relay disabled. This device will still send and receive its own packets.');
    refreshBleUI();
  };
  window.addEventListener('proxitalk-ble-error', event => {
    toast(String(event.detail || 'Bluetooth permission was not granted'));
  });
  $('meshPanelBtn').onclick = () => {
    $('meshPanel').classList.toggle('hidden');
    refreshBleUI();
  };
  $('meshClose').onclick = () => $('meshPanel').classList.add('hidden');
  $('searchInput').oninput = e => { search = e.target.value; renderChatList(); };
  $('filterTabs').querySelectorAll('.tab').forEach(t => t.onclick = () => {
    $('filterTabs').querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); filter = t.dataset.filter; renderChatList();
  });
  $('backBtn').onclick = () => {
    $('sidebar').classList.remove('hide-mobile');
    $('chatArea').classList.remove('show-mobile');
  };

  async function syncMissingContactSigningKeys() {
    if (!authUser || !currentProfile || !ProxiAuth.isSignedIn()) return;
    let changed = false;
    for (const contact of contacts) {
      if (!contact.userId) continue;
      const needsRefresh = !contact.signingPublicKey || !ProxiIdentity.isProxiTalkId(contact.proxiId) || contact.proxiId !== contact.phone;
      if (!needsRefresh) continue;
      try {
        const remote = await ProxiCloud.findDirectoryByUserId(contact.userId);
        if (remote) {
          if (contact.proxiId !== remote.proxitalk_id) { contact.proxiId = remote.proxitalk_id; changed = true; }
          if (contact.phone !== remote.proxitalk_id) { contact.phone = remote.proxitalk_id; changed = true; }
          if (remote.signing_public_key && JSON.stringify(contact.signingPublicKey) !== JSON.stringify(remote.signing_public_key)) {
            contact.signingPublicKey = remote.signing_public_key; changed = true;
          }
        }
      } catch (error) { console.warn('[ProxiTalk] contact directory refresh failed', error); }
    }
    if (changed) persist();
  }

  // ── Init ───────────────────────────────────────────────────
  MeshEngine.init($('meshCanvas'), { onDeliver: onMeshDeliver, onStats: onMeshStats });
  refreshBleUI();
  if (ProxiBLE.detect() === 'native-discovery') setInterval(() => { refreshBleUI(); pollBlePackets(); }, 1500);
  $('myAvatar').textContent = currentProfile ? initials(currentProfile.display_name) : 'PT';
  $('myAvatar').title = currentProfile?.proxitalk_id || 'Account settings';
  $('meshPillText').textContent = offlineMode ? 'Local drafts only' : (currentProfile ? 'Online mailbox ready' : 'Sign in to message');
  $('queueCount').textContent = Object.values(chats).reduce((n, list) => n + list.filter(m => m.status === 'local').length, 0) + ' local drafts';
  $('msgInput').placeholder = offlineMode ? 'Write a local draft (not sent)…' : 'Write a message…';
  $('myAvatar').onclick = () => $('settingsBtn').click();
  renderChatList();
  if (authUser && currentProfile) {
    syncMissingContactSigningKeys();
    if (keyAvailable && signingKeyAvailable) {
      ProxiCalls.initialize({ userId: authUser.id, profile: currentProfile, cloud: ProxiCloud, crypto: ProxiCrypto,
        getContact: async peer => contacts.find(contact => contact.userId === peer.user_id) || null });
    }
    pollInbox();
    setInterval(pollInbox, 5000);
    window.addEventListener('online', pollInbox);
  }

  // Welcome toast
  setTimeout(() => toast(offlineMode ? 'Offline mode: drafts stay on this device and are not sent.' : (currentProfile ? 'Signed in. Share your ProxiTalk ID to start an encrypted chat.' : 'Sign in to create a ProxiTalk account.')), 800);

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
