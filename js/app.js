/* ═══════════════════════════════════════════════════════════════
   ProxiTalk App — UI, chats, messages, media, SOS, settings
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // No seeded contacts, sample conversations, or fabricated message history.
  const localProfileId = Store.load('profile_id', null) || (() => {
    const id = 'pt-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14));
    Store.save('profile_id', id);
    return id;
  })();

  // ── State ──────────────────────────────────────────────────
  let contacts = Store.load('contacts', []);
  let chats = Store.load('chats', {});       // Local-only conversations by contact ID
  if (!Array.isArray(contacts)) contacts = [];
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) chats = {};
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
  if (hadLegacyContacts || migratedDrafts) persist();

  function persist() {
    Store.save('contacts', contacts);
    Store.save('chats', chats);
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
        <div class="avatar" style="background:${c.color}">${initials(c.name)}</div>
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
      if (m.type === 'image' && m.dataUrl) body = `<img class="msg-img" src="${m.dataUrl}" alt="photo">`;
      else if (m.type === 'voice') body = '<span class="text">Voice attachment unavailable in this preview</span>'; else if (m.type === 'file') {
        body = `<div class="file-chip"><span class="fic">📄</span><div><b>${esc(m.fileName || 'file')}</b><span>${esc(m.fileSize || '')} · via mesh</span></div></div>`;
      } else if (m.type === 'location') {
        body = `<div class="file-chip"><span class="fic">📍</span><div><b>${esc(m.text || 'Location')}</b><span>Shared via mesh</span></div></div>`;
      } else {
        body = `<span class="text">${esc(m.text || '')}</span>`;
      }
      const replyHtml = m.replyTo ? `<div class="reply-quote"><b>${esc(m.replyTo.sender || 'You')}</b><span>${esc(m.replyTo.text || '')}</span></div>` : '';
      const reaction = m.reaction ? `<span class="reaction">${m.reaction}</span>` : '';
      const sosCls = m.isSOS ? ' sos-bubble' : '';
      const statusChip = m.status === 'local' ? '<span class="status-chip">Saved here · not sent</span>' : '';
      html += `
        <div class="msg-row ${isMe ? 'me' : 'them'}">
          <div class="bubble${sosCls}" data-mid="${m.id}">
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
    $('chatStatus').textContent = last && last.status === 'local' ? 'Saved on this device · not sent' : 'Local-only preview · transport not connected';
    $('hopBadge').textContent = 'local only';
  }

  // ── Send message ───────────────────────────────────────────
  async function sendMessage(text, opts = {}) {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msg = {
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
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
    $('msgInput').placeholder = 'Write a local draft (not sent)…';

    // This preview persists drafts locally only; it does not transmit or encrypt messages.
    (chats[activeChat] = chats[activeChat] || []).push(msg);
    persist();
    renderMessages(); renderChatList(); updateChatStatus();
    toast('Saved on this device only — not sent to the contact');
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
    sl.innerHTML = syncLog.length ? syncLog.map(s => `<div class="sync-item"><span class="s-ico">☁️</span><div><b>${esc(s.text)}</b><span>${esc(s.time)}</span></div></div>`).join('') : '<p class="muted">Cloud sync disabled until authenticated access and row-level security are in place.</p>';

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
    const rows = contacts.filter(c => !c.isGroup).map(c => `
      <div class="contact-row" data-id="${esc(c.id)}">
        <div class="avatar" style="background:${c.color}">${initials(c.name)}</div>
        <div><b>${esc(c.name)}</b><span>${esc(c.about || '')} · ${esc(c.phone || '')}</span></div>
        <span class="sel">›</span>
      </div>`).join('');
    openModal('New Chat', rows + `<div class="field" style="margin-top:14px"><label>Or add a contact ID / phone locally</label><input id="newIdInput" placeholder="Enter a contact ID or phone number"><small class="muted">IDs are not looked up or verified. Messages remain on this device.</small><button class="btn-primary" id="newIdGo" style="margin-top:8px">Start Local Chat</button></div>`);
    $('modalBody').querySelectorAll('.contact-row').forEach(r => r.onclick = () => { closeModal(); openChat(r.dataset.id); });
    $('newIdGo').onclick = () => {
      const id = $('newIdInput').value.trim();
      if (!id) return;
      let c = contactById(id);
      if (!c) {
        c = { name: id, id, color: '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'), phone: id, about: 'ID entered locally; not verified' };
        contacts.push(c); persist();
      }
      closeModal(); openChat(id);
    };
  };

  $('newGroupBtn').onclick = () => {
    openModal('New Group', `
      <div class="field"><label>Group name</label><input id="grpName" placeholder="e.g. Family, Church, Class…"></div>
      <div class="field"><label>Members (comma separated names)</label><input id="grpMembers" placeholder="Add member IDs separated by commas"></div>
      <button class="btn-primary" id="grpCreate">Create Group</button>`);
    $('grpCreate').onclick = () => {
      const name = $('grpName').value.trim();
      if (!name) return toast('Enter a group name');
      const members = $('grpMembers').value.split(',').map(s => s.trim()).filter(Boolean);
      const c = { name, id: name, color: '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'), phone: '', about: (members.length + 1) + ' members (local only)', isGroup: true, members };
      contacts.push(c); chats[name] = chats[name] || []; persist(); closeModal(); openChat(name);
      toast('Group created locally; messages are not broadcast or sent.');
    };
  };

  // ── Settings ───────────────────────────────────────────────
  $('settingsBtn').onclick = async () => {
    openModal('Settings', `
      <div class="detail-row"><span>Local device ID</span><b>${esc(localProfileId)}</b></div>
      <div class="detail-row"><span>Encryption status</span><b>Not enabled for messaging in this preview</b></div>
      <div class="detail-row"><span>Transport</span><b>Not connected in this web build</b></div>
      <div class="detail-row"><span>Storage</span><b>Browser local storage on this device</b></div>
      <div class="detail-row"><span>Cloud sync</span><b>Disabled pending authenticated backend</b></div>
      <p style="font-size:12px;color:var(--muted);margin-top:12px;line-height:1.6">This is an early-access local preview. Messages and contacts stay in this browser and are not sent, encrypted for a recipient, or synced to other devices. Do not use it for emergencies or sensitive communication.</p>
      <button class="btn-primary" id="wipeBtn" style="margin-top:12px;background:#3D1A20;color:#FF8A96">Clear all local data</button>`);
    $('wipeBtn').onclick = () => { localStorage.clear(); location.reload(); };
  };

  // ── Chat info (hop path) ───────────────────────────────────
  $('infoBtn').onclick = () => {
    if (!activeChat) return;
    const c = contactById(activeChat);
    const msgs = chats[activeChat] || [];
    const last = msgs[msgs.length - 1];
    const path = ['This device'];
    openModal('Chat Info', `
      <div class="detail-row"><span>Name</span><b>${esc(c.name)}</b></div>
      <div class="detail-row"><span>About</span><b>${esc(c.about || '—')}</b></div>
      <div class="detail-row"><span>Phone / ID</span><b>${esc(c.phone || c.id)}</b></div>
      <div class="detail-row"><span>Message privacy</span><b>Local browser storage only; not end-to-end encrypted</b></div>
      <div class="detail-row"><span>Delivery</span><b>${last?.status === 'local' ? 'Not sent' : 'No transport'}</b></div>
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
      reader.onload = () => sendMessage('📷 Photo (' + sizeKb + ' KB, compressed for mesh)', { type: 'image', dataUrl: reader.result, fileName: file.name, fileSize: sizeKb + ' KB' });
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
  $('myAvatar').textContent = 'PT';
  renderChatList();

  // Welcome toast
  setTimeout(() => toast('Local-only preview: messages are saved here and are not transmitted.'), 800);

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
