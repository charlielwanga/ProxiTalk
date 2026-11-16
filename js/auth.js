/* Small Supabase Auth client for the static app. Only public keys are used in-browser. */
const ProxiAuth = (() => {
  const cfg = window.ProxiTalkConfig;
  const STORAGE_KEY = 'proxitalk_auth_session_v1';
  const PKCE_KEY = 'proxitalk_auth_pkce_verifier';
  let session = null;
  let user = null;
  let callbackError = '';

  function readSavedSession() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveSession(value) {
    session = value;
    try { value ? sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)) : sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }
  function saveVerifier(value) {
    try { localStorage.setItem(PKCE_KEY, JSON.stringify({ value, createdAt: Date.now() })); } catch (_) {}
  }
  function readVerifier() {
    try {
      const saved = JSON.parse(localStorage.getItem(PKCE_KEY) || 'null');
      if (!saved?.value || Date.now() - saved.createdAt > 15 * 60 * 1000) { localStorage.removeItem(PKCE_KEY); return null; }
      return saved.value;
    } catch (_) { return null; }
  }
  function clearVerifier() { try { localStorage.removeItem(PKCE_KEY); } catch (_) {} }
  function headers(token = null) {
    return {
      apikey: cfg.publishableKey,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json',
    };
  }
  async function request(path, options = {}) {
    const response = await fetch(cfg.supabaseUrl + path, options);
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { message: raw }; }
    if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || 'Authentication request failed (' + response.status + ')');
    return data;
  }
  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  }
  function cleanCallbackUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    url.searchParams.delete('error_code');
    url.searchParams.delete('error_description');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
  }
  async function acceptAuthCallback() {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    if (code) {
      const verifier = readVerifier();
      if (!verifier) throw new Error('This sign-in link expired or was opened in a different browser. Request a new link and open it in this browser.');
      try {
        const data = await request('/auth/v1/token?grant_type=pkce', {
          method: 'POST', headers: headers(), body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
        });
        saveSession({ ...data, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
        cleanCallbackUrl();
        return true;
      } finally { clearVerifier(); }
    }
    const hash = new URLSearchParams(location.hash.slice(1));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const expiresIn = Number(hash.get('expires_in') || 3600);
    const type = hash.get('type');
    if (!accessToken || !refreshToken || !['magiclink', 'signup', 'recovery'].includes(type)) return false;
    saveSession({ access_token: accessToken, refresh_token: refreshToken, expires_at: Date.now() + expiresIn * 1000 });
    cleanCallbackUrl();
    return true;
  }
  async function refreshSession() {
    if (!session?.refresh_token) return null;
    try {
      const data = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      saveSession({ ...data, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
      return session;
    } catch (_) { saveSession(null); user = null; return null; }
  }
  async function getValidSession() {
    session ||= readSavedSession();
    if (!session) return null;
    if (!session.access_token || !session.expires_at || session.expires_at < Date.now() + 30000) {
      return refreshSession();
    }
    return session;
  }
  async function initialize() {
    try { await acceptAuthCallback(); }
    catch (error) {
      callbackError = error.message || 'Could not complete sign-in.';
      cleanCallbackUrl();
    }
    session ||= readSavedSession();
    const valid = await getValidSession();
    if (!valid) return null;
    try {
      user = await request('/auth/v1/user', { headers: headers(valid.access_token) });
      return user;
    } catch (_) { saveSession(null); user = null; return null; }
  }
  function authRedirectUri() {
    try {
      const nativeUri = window.ProxiTalkNative?.getAuthRedirectUrl?.();
      if (nativeUri === 'com.proxitalk.app://auth/callback') return nativeUri;
    } catch (_) {}
    return location.origin + location.pathname;
  }
  async function sendMagicLink(email) {
    callbackError = '';
    const redirect = authRedirectUri();
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    saveVerifier(verifier);
    try {
      await request('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect), {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ email: email.trim().toLowerCase(), create_user: true, code_challenge: challenge, code_challenge_method: 's256' }),
      });
    } catch (error) { clearVerifier(); throw error; }
  }
  async function accessToken() {
    const valid = await getValidSession();
    return valid?.access_token || null;
  }
  async function signOut() {
    const token = await accessToken();
    try { if (token) await request('/auth/v1/logout?scope=local', { method: 'POST', headers: headers(token) }); } catch (_) {}
    saveSession(null); user = null;
  }
  function getUser() { return user; }
  function getError() { return callbackError; }
  function isSignedIn() { return !!(session?.access_token && user?.id); }
  function getConfig() { return { url: cfg.supabaseUrl }; }

  return { initialize, sendMagicLink, accessToken, signOut, getUser, getError, isSignedIn, getConfig };
})();
