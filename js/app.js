/* ═══════════════════════════════════════════════════════════════
   ProxiTalk App — UI, chats, messages, media, SOS, settings
   ═══════════════════════════════════════════════════════════════ */
(async function () {
  'use strict';

  let authUser = await ProxiAuth.initialize();
  Store.setNamespace(authUser?.id || '');
  let currentProfile = null;
  let offlineMode = !authUser && sessionStorage.getItem('proxitalk_continue_offline') === '1';
  if (authUser) {
    try { currentProfile = await ProxiCloud.findDirectoryByUserId(authUser.id); }
    catch (error) { console.warn('[ProxiTalk] profile lookup failed', error); }
  }
  let keyAvailable = !authUser || !currentProfile;
  let initialChats = Store.load('chats', {});
  if (authUser && currentProfile) {
    try {
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      keyAvailable = publicKey.x === currentProfile.public_key.x && publicKey.y === currentProfile.public_key.y;
      if (keyAvailable) initialChats = await ProxiCrypto.decryptLocalData(initialChats);
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

  // Remove prototype fixtures and synthetic inbound traffic from older installs;
  // preserve only user-authored local drafts and mark them as unsent.
  const legacyIds = new Set(['Amina', 'Brian', 'Cathy', 'David', 'Esther', 'Kampala Market Group', 'Emergency SOS Network']);
  const hadLegacyContacts = contacts.some(c => legacyIds.has(c.id));
  contacts = contacts.filter(c => !legacyIds.has(c.id));
  legacyIds.forEach(id => { delete chats[id]; });
  let migratedDrafts = false;
  for (const id of Object.keys(chats)) {
    const messages = Array.isArray(chats[id]) ? chats[id] : [];
    const drafts = messages.filter(m => m.from === 'me');
    if (drafts.length !== messages.length) migratedDrafts = true;
    drafts.forEach(m => {
      if (m.status !== 'local' || m.encrypted || m.hops || m.path || m.cipher) migratedDrafts = true;
      m.status = 'local'; m.encrypted = false; m.hops = 0;
      delete m.path; delete m.cipher;
    });
    chats[id] = drafts;
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
  function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#128C7E'; }
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

  async function finishSignIn() {
    const status = $('authStatus');
    try {
      authUser = await ProxiAuth.initialize();
      if (!authUser) throw new Error('Sign-in link was not accepted. Open the latest email link in this browser.');
      Store.setNamespace(authUser.id);
      currentProfile = await ProxiCloud.findDirectoryByUserId(authUser.id);
      if (!currentProfile) {
        $('authForm').classList.add('hidden');
        $('continueOffline').classList.add('hidden');
        $('profileForm').classList.remove('hidden');
        $('authIntro').textContent = 'Choose a display name to create your ProxiTalk identity.';
        status.textContent = '';
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
  $('continueOffline').addEventListener('click', () => {
    sessionStorage.setItem('proxitalk_continue_offline', '1');
    location.reload();
  });
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!authUser) return;
    const button = $('profileForm').querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const displayName = $('profileName').value.trim().replace(/\s+/g, ' ');
      if (!displayName || displayName.length > 48) throw new Error('Enter a display name of 1 to 48 characters.');
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      let record = null;
      for (let attempt = 0; attempt < 3 && !record; attempt++) {
        const id = 'PT-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0').toUpperCase();
        try { record = await ProxiCloud.createDirectoryProfile({ userId: authUser.id, proxiId: id, displayName, publicKey }); }
        catch (error) { if (attempt === 2) throw error; }
      }
      if (!record) throw new Error('Could not create your profile. Please try again.');
      sessionStorage.removeItem('proxitalk_continue_offline');
      location.reload();
    } catch (error) {
      $('authStatus').textContent = error.message || 'Could not create your profile.';
      button.disabled = false;
    }
  });
  if (!authUser && ProxiAuth.getError()) $('authStatus').textContent = ProxiAuth.getError();
  if (authUser && currentProfile) {
    try {
      const publicKey = await ProxiCrypto.ensureIdentity(authUser.id);
      if (keyAvailable && publicKey.x === currentProfile.public_key.x && publicKey.y === currentProfile.public_key.y) {
        $('authOverlay').classList.add('hidden');
        sessionStorage.removeItem('proxitalk_continue_offline');
      } else {
        $('authStatus').textContent = 'This browser does not have the private key for this account. Sign-in cannot recover it; use the original device/browser.';
        $('authForm').classList.add('hidden');
        $('continueOffline').classList.remove('hidden');
      }
    } catch (error) { $('authStatus').textContent = error.message; }
  } else if (authUser) {
    $('authForm').classList.add('hidden');
    $('continueOffline').classList.add('hidden');
    $('profileForm').classList.remove('hidden');
    $('authIntro').textContent = 'Choose a display name to create your ProxiTalk identity.';
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
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.id.toLowerCase().includes(search.toLowerCase())) return false;
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
      const statusChip = m.status === 'local' ? '<span class="status-chip">Saved here · not sent</span>' : (m.status === 'sent' ? '<span class="status-chip">Encrypted · server queued</span>' : '');
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
    $('chatStatus').textContent = offlineMode ? 'Local drafts only · not sent' : (last?.status === 'local' ? 'Saved on this device · not sent' : (c?.proxiId ? 'Encrypted online messaging' : 'Choose a verified ProxiTalk ID'));
    $('hopBadge').textContent = last?.status === 'sent' ? 'server queued' : 'no mesh';
  }

  // ── Send message ───────────────────────────────────────────
  async function sendMessage(text, opts = {}) {
    if (!activeChat) return;
    const c = contactById(activeChat);
    if (!c) return;
    const msg = {
      id: 'm_' + crypto.randomUUID(),
      from: 'me', toName: c.id, text,
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
      await ProxiCloud.sendEncryptedMessage(authUser.id, c, text);
      msg.status = 'sent'; msg.encrypted = true;
      persist(); renderMessages(); renderChatList(); updateChatStatus();
      toast('Encrypted and queued for delivery');
    } catch (error) {
      console.warn('[ProxiTalk] encrypted message not sent', error);
      toast('Not sent: ' + (error.message || 'network error') + '. It remains a local draft.');
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
          contact = { id: remote.proxitalk_id, proxiId: remote.proxitalk_id, userId: remote.user_id, publicKey: remote.public_key, name: remote.display_name, color: '#128C7E', about: 'Verified ProxiTalk contact', phone: remote.proxitalk_id };
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
        <div><b>${esc(c.name)}</b><span>Verified ProxiTalk ID · ${esc(c.proxiId)}</span></div>
        <span class="sel">›</span>
      </div>`).join('');
    openModal('New encrypted chat', `${rows || '<p class="muted">No contacts yet. Add someone using their ProxiTalk ID.</p>'}<div class="field" style="margin-top:14px"><label>Contact ProxiTalk ID</label><input id="newIdInput" maxlength="11" placeholder="PT-1A2B3C4D"><small class="muted">Looked up in the signed-in directory. Check the identity fingerprint with your contact for sensitive conversations.</small><button class="btn-primary" id="newIdGo" style="margin-top:8px">Find and add contact</button></div>`);
    $('modalBody').querySelectorAll('.contact-row').forEach(r => r.onclick = () => { closeModal(); openChat(r.dataset.id); });
    $('newIdGo').onclick = async () => {
      const id = $('newIdInput').value.trim().toUpperCase();
      if (!/^PT-[0-9A-F]{8}$/.test(id)) return toast('Enter a ProxiTalk ID in the form PT-1A2B3C4D');
      if (!authUser || offlineMode) return toast('Sign in to look up verified online contacts');
      try {
        const remote = await ProxiCloud.findDirectoryById(id);
        if (!remote) return toast('No account found for that ProxiTalk ID');
        if (remote.user_id === authUser.id) return toast('That is your own ProxiTalk ID');
        let c = contacts.find(item => item.userId === remote.user_id);
        if (!c) {
          c = { id: remote.proxitalk_id, proxiId: remote.proxitalk_id, userId: remote.user_id, publicKey: remote.public_key, name: remote.display_name, color: '#128C7E', phone: remote.proxitalk_id, about: 'Verified ProxiTalk contact' };
          contacts.push(c); persist(); renderChatList();
        }
        closeModal(); openChat(c.id);
      } catch (error) { toast(error.message || 'Could not search the directory'); }
    };
  };

  $('newGroupBtn').onclick = () => toast('Encrypted group messaging is not available yet. Only one-to-one text messages are supported.');

  // ── Settings ───────────────────────────────────────────────
  $('settingsBtn').onclick = async () => {
    const fingerprint = currentProfile ? await ProxiCrypto.fingerprint(currentProfile.public_key) : 'Local drafts only';
    openModal('Account & security', `
      <div class="detail-row"><span>${currentProfile ? 'Your ProxiTalk ID' : 'Local draft ID · not registered'}</span><b>${esc(currentProfile?.proxitalk_id || localProfileId)}</b></div>
      ${currentProfile ? `<div class="detail-row"><span>Key fingerprint</span><b>${esc(fingerprint)}</b></div><button class="btn-primary" id="copyIdBtn" style="margin:8px 0">Copy my ProxiTalk ID</button>` : ''}
      <div class="detail-row"><span>Account</span><b>${authUser ? esc(authUser.email || 'Signed in') : 'Not signed in'}</b></div>
      <div class="detail-row"><span>Message security</span><b>Recipient public-key encryption for online text</b></div>
      <div class="detail-row"><span>Delivery</span><b>${offlineMode || !authUser ? 'Local drafts only; not sent' : 'Internet mailbox · no Bluetooth relay'}</b></div>
      <div class="detail-row"><span>Device storage</span><b>Private key is device-bound; no key recovery</b></div>
      <p style="font-size:12px;color:var(--muted);margin-top:12px;line-height:1.6">Compare your key fingerprint with your contact out of band to detect directory key changes. New devices cannot decrypt old messages. Attachments, groups, calls, and emergency SOS are not supported. Do not rely on ProxiTalk for emergencies.</p>
      ${authUser ? '<button class="btn-primary" id="signOutBtn" style="margin-top:12px">Sign out</button>' : ''}
      <button class="btn-primary" id="wipeBtn" style="margin-top:12px;background:#3D1A20;color:#FF8A96">Clear local chat data</button>`);
    if (currentProfile) $('copyIdBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(currentProfile.proxitalk_id); toast('ProxiTalk ID copied. Verify fingerprints out of band before sensitive chats.'); }
      catch (_) { toast('Your ProxiTalk ID is ' + currentProfile.proxitalk_id); }
    };
    $('wipeBtn').onclick = () => { Store.setNamespace(authUser?.id || ''); localStorage.removeItem('proxitalk_' + (authUser?.id ? authUser.id + '_' : '') + 'contacts'); localStorage.removeItem('proxitalk_' + (authUser?.id ? authUser.id + '_' : '') + 'chats'); location.reload(); };
    if (authUser) $('signOutBtn').onclick = async () => { await ProxiAuth.signOut(); ProxiCrypto.clearMemory(); sessionStorage.removeItem('proxitalk_continue_offline'); location.reload(); };
  };

  // ── Chat info (hop path) ───────────────────────────────────
  $('infoBtn').onclick = async () => {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msgs = chats[activeChat] || [];
    const last = msgs[msgs.length - 1];
    const path = ['This device'];
    const fingerprint = c.publicKey ? await ProxiCrypto.fingerprint(c.publicKey) : 'Not verified';
    openModal('Chat Info', `
      <div class="detail-row"><span>Name</span><b>${esc(c.name)}</b></div>
      <div class="detail-row"><span>About</span><b>${esc(c.about || '—')}</b></div>
      <div class="detail-row"><span>Phone / ID</span><b>${esc(c.phone || c.id)}</b></div>
      <div class="detail-row"><span>Public-key fingerprint</span><b>${esc(fingerprint)}</b></div>
      <div class="detail-row"><span>Message privacy</span><b>Recipient-key encrypted online text</b></div>
      <div class="detail-row"><span>Delivery</span><b>${last?.status === 'local' ? 'Local draft · not sent' : last?.status === 'sent' ? 'Accepted by encrypted mailbox' : 'No message sent'}</b></div>
      <h4 style="margin-top:14px;font-size:12px;color:var(--muted)">LAST MESSAGE PATH</h4>
      <div class="hop-path">${path.map((p, i) => `${i ? '<span class="hop-arrow">→</span>' : ''}<span class="hop-node">${esc(p)}</span>`).join('')}</div>
      <p style="font-size:12px;color:var(--muted)">No Bluetooth hop path exists in this local-only preview.</p>`);
  };

  // ── Mesh voice calls ───────────────────────────────────────
  $('callBtn').onclick = () => toast('Voice calls are not available in this build: live mesh signaling is not implemented.');

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

  // Internet, relay, SOS, and transport toggles are intentionally absent here;
  // this build does not simulate connectivity or claim message delivery.

  // ── Panel / search / filters / back ────────────────────────
  $('meshPanelBtn').onclick = () => $('meshPanel').classList.toggle('hidden');
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

  // No background scanning, cloud heartbeat, or network claims are made in this preview.

  // ── Init ───────────────────────────────────────────────────
  MeshEngine.init($('meshCanvas'), { onDeliver: onMeshDeliver, onStats: onMeshStats });
  $('myAvatar').textContent = currentProfile ? initials(currentProfile.display_name) : 'PT';
  $('myAvatar').title = currentProfile?.proxitalk_id || 'Account settings';
  $('meshPillText').textContent = offlineMode ? 'Local drafts only' : (currentProfile ? 'Online mailbox ready' : 'Sign in to message');
  $('queueCount').textContent = Object.values(chats).reduce((n, list) => n + list.filter(m => m.status === 'local').length, 0) + ' local drafts';
  $('msgInput').placeholder = offlineMode ? 'Write a local draft (not sent)…' : 'Write a message…';
  $('myAvatar').onclick = () => $('settingsBtn').click();
  renderChatList();
  if (authUser && currentProfile) {
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
