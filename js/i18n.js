/* ═══════════════════════════════════════════════════════════════
   ProxiTalk i18n — English / Luganda / Swahili
   Luganda (Uganda) + Swahili (East Africa) for community adoption.
   ═══════════════════════════════════════════════════════════════ */
const ProxiI18n = (() => {
  const DICT = {
    en: {
      search: 'Search chats, people, IDs…', newChat: '＋ New Chat', newGroup: '👥 Group', sos: '🆘 SOS',
      all: 'All', unread: 'Unread', groups: 'Groups',
      messagePlaceholder: 'Message via mesh…', send: 'Send',
      internet: 'Internet', online: 'ONLINE', offline: 'OFFLINE', relay: 'Relay',
      outageTitle: 'INTERNET OUTAGE MODE', outageBody: 'ProxiTalk mesh is active. Messages relay phone-to-phone via Bluetooth. Gateway nodes will sync to cloud when internet returns.',
      meshNetwork: 'Mesh Network', queue: 'Store-and-Forward Queue', gatewayLog: 'Gateway Sync Log', nearbyNodes: 'Nearby Nodes', meshSettings: 'Mesh Settings',
      nodesNearby: 'nodes nearby', queued: 'queued', delivered: 'delivered', avgHops: 'avg hops', saved: 'MB saved',
      typing: 'typing…', encrypted: 'End-to-end encrypted', noMessages: 'No messages yet. Say hello! 👋',
      language: 'Language', settings: 'Settings',
    },
    lg: {
      search: 'Noonya obukwano, abantu, ID…', newChat: '＋ Obukwano Obupya', newGroup: '👥 Ekibiina', sos: '🆘 SOS',
      all: 'Byonna', unread: 'Ebyatassoma', groups: 'Ebibiina',
      messagePlaceholder: 'Okuweereza okuyita mu mesh…', send: 'Weereza',
      internet: 'Internet', online: 'ONLINE', offline: 'OFFLINE', relay: 'Relay',
      outageTitle: 'OMUTWE GWA INTERNET GUMAZE', outageBody: 'Mesh ya ProxiTalk ekola. Obukwano buyita ku ssimu okutu ssimu. Abantu abalina internet balisindika ku cloud.',
      meshNetwork: 'Mesh Network', queue: 'Ebyalindiriirwa', gatewayLog: 'Gateway Sync Log', nearbyNodes: 'Abali okumpi', meshSettings: 'Mesh Settings',
      nodesNearby: 'abali okumpi', queued: 'byalindiriirwa', delivered: 'byatuuka', avgHops: 'avg hops', saved: 'MB saved',
      typing: 'awandiika…', encrypted: 'Ebyakweebwa', noMessages: 'Tewali bukwano bwonna. Mwasuze! 👋',
      language: 'Olulimi', settings: 'Settings',
    },
    sw: {
      search: 'Tafuta mazungumzo, watu, ID…', newChat: '＋ Chat Mpya', newGroup: '👥 Kikundi', sos: '🆘 SOS',
      all: 'Yote', unread: 'Sijasomwa', groups: 'Vikundi',
      messagePlaceholder: 'Tuma ujumbe kupitia mesh…', send: 'Tuma',
      internet: 'Internet', online: 'ONLINE', offline: 'OFFLINE', relay: 'Relay',
      outageTitle: 'HALI YA KUKATIKA INTERNET', outageBody: 'Mesh ya ProxiTalk inafanya kazi. Ujumbe hupita simu hadi simu. Simu zenye internet zitasawazisha na cloud.',
      meshNetwork: 'Mesh Network', queue: 'Foleni ya Kusubiri', gatewayLog: 'Gateway Sync Log', nearbyNodes: 'Nodi za Karibu', meshSettings: 'Mesh Settings',
      nodesNearby: 'nodi karibu', queued: 'zimesubiri', delivered: 'zimefika', avgHops: 'avg hops', saved: 'MB saved',
      typing: 'anaandika…', encrypted: 'Imesimbwa', noMessages: 'Hakuna ujumbe bado. Sema habari! 👋',
      language: 'Lugha', settings: 'Settings',
    },
  };
  const LANGS = [
    { code: 'en', label: 'English', flag: '🇬🇧' },
    { code: 'lg', label: 'Olulimi (Luganda)', flag: '🇺🇬' },
    { code: 'sw', label: 'Kiswahili', flag: '🇰🇪' },
  ];
  let lang = Store.load('lang', 'en');

  function t(key) { return (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key; }
  function setLang(code) { lang = code; Store.save('lang', code); apply(); }
  function getLang() { return lang; }
  function getLangs() { return LANGS; }

  function apply() {
    const set = (id, key, attr) => { const el = document.getElementById(id); if (el) el[attr || 'textContent'] = t(key); };
    const setPh = (id, key) => { const el = document.getElementById(id); if (el) el.placeholder = t(key); };
    setPh('searchInput', 'search');
    setPh('msgInput', 'messagePlaceholder');
    set('newChatBtn', 'newChat'); set('newGroupBtn', 'newGroup'); set('sosBtn', 'sos');
    set('internetState', internetOnlineGlobal() ? 'online' : 'offline');
    set('relayState', relayOnGlobal() ? 'online' : 'offline');
    document.querySelectorAll('#filterTabs .tab').forEach(tab => {
      const f = tab.dataset.filter;
      if (f === 'all') tab.textContent = t('all');
      if (f === 'unread') tab.innerHTML = t('unread') + ' <span class="badge" id="unreadBadge">0</span>';
      if (f === 'groups') tab.textContent = t('groups');
      if (f === 'sos') tab.textContent = '🆘 SOS';
    });
    const banner = document.querySelector('#outageBanner span');
    if (banner) banner.innerHTML = '⚡ <strong>' + t('outageTitle') + '</strong> — ' + t('outageBody');
  }
  function internetOnlineGlobal() { return typeof internetOnline !== 'undefined' ? internetOnline : true; }
  function relayOnGlobal() { return typeof relayOn !== 'undefined' ? relayOn : true; }

  return { t, setLang, getLang, getLangs, apply };
})();
