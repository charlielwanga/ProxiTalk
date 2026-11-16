/* ═══════════════════════════════════════════════════════════════
   ProxiTalk Storage — Offline-first persistence (localStorage)
   Everything survives app restarts and works fully offline.
   ═══════════════════════════════════════════════════════════════ */
const Store = (() => {
  const PREFIX = 'proxitalk_';
  function save(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { console.warn('Store save failed', e); }
  }
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function remove(key) { try { localStorage.removeItem(PREFIX + key); } catch (e) {} }
  return { save, load, remove };
})();
