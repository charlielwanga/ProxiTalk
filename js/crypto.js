/* ProxiTalk E2E encryption: ephemeral P-256 ECDH + HKDF-SHA-256 + AES-256-GCM.
 * Device private keys are non-extractable CryptoKeys stored in IndexedDB.
 * The database/cloud sees only the encrypted envelope and public directory key.
 */
const ProxiCrypto = (() => {
  const DB_NAME = 'proxitalk-device-keys';
  const STORE = 'identities';
  const encoder = new TextEncoder();
  let currentUserId = null;
  let currentPrivateKey = null;
  let currentPublicJwk = null;

  function toB64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function fromB64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  function openDb() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('Secure key storage is unavailable in this browser'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'userId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open device key storage'));
    });
  }
  async function readIdentity(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(userId);
      request.onsuccess = () => { db.close(); resolve(request.result || null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }
  async function saveIdentity(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save device keys')); };
    });
  }

  async function generateIdentity() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk };
  }

  async function ensureIdentity(userId) {
    if (!userId) throw new Error('Authenticated user ID is required for key storage');
    if (currentUserId === userId && currentPrivateKey && currentPublicJwk) return currentPublicJwk;
    const saved = await readIdentity(userId);
    if (saved) {
      currentPrivateKey = saved.privateKey;
      currentPublicJwk = saved.publicJwk;
    } else {
      const identity = await generateIdentity();
      currentPrivateKey = identity.privateKey;
      currentPublicJwk = identity.publicJwk;
      await saveIdentity({ userId, privateKey: identity.privateKey, publicJwk: identity.publicJwk, createdAt: Date.now() });
    }
    currentUserId = userId;
    return currentPublicJwk;
  }

  async function deriveAesKey(privateKey, peerPublicJwk, salt, usages) {
    const peer = await crypto.subtle.importKey('jwk', peerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('ProxiTalk direct message v1') },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }

  async function encryptFor(recipientPublicJwk, plaintext) {
    if (!recipientPublicJwk || recipientPublicJwk.kty !== 'EC' || recipientPublicJwk.crv !== 'P-256') {
      throw new Error('Recipient does not have a supported public key');
    }
    const ephemeral = await generateIdentity();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(ephemeral.privateKey, recipientPublicJwk, salt, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(String(plaintext)));
    return {
      v: 1,
      alg: 'ECDH-P256/HKDF-SHA256/AES-256-GCM',
      epk: ephemeral.publicJwk,
      salt: toB64(salt),
      iv: toB64(iv),
      ct: toB64(new Uint8Array(ciphertext)),
    };
  }

  async function decryptWithPrivateKey(privateKey, envelope) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'ECDH-P256/HKDF-SHA256/AES-256-GCM') {
      throw new Error('Unsupported or invalid encrypted message');
    }
    const key = await deriveAesKey(privateKey, envelope.epk, fromB64(envelope.salt), ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
    return new TextDecoder().decode(plaintext);
  }

  async function decryptFromMe(envelope) {
    if (!currentPrivateKey) throw new Error('Device encryption key is not unlocked');
    return decryptWithPrivateKey(currentPrivateKey, envelope);
  }

  async function localHistoryKey(usages) {
    if (!currentPrivateKey || !currentPublicJwk) throw new Error('Device encryption key is not unlocked');
    const ownPublic = await crypto.subtle.importKey('jwk', currentPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: ownPublic }, currentPrivateKey, 256);
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const salt = await crypto.subtle.digest('SHA-256', encoder.encode('ProxiTalk local history v1'));
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('device-bound local message history') },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }

  async function encryptLocalData(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await localHistoryKey(['encrypt']);
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
    return { _proxitalkEncrypted: 1, alg: 'AES-256-GCM/device-v1', iv: toB64(iv), ct: toB64(new Uint8Array(ciphertext)) };
  }

  async function decryptLocalData(value) {
    if (!value || value._proxitalkEncrypted !== 1) return value;
    if (value.alg !== 'AES-256-GCM/device-v1') throw new Error('Unsupported local-history encryption format');
    const key = await localHistoryKey(['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(value.iv) }, key, fromB64(value.ct));
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function fingerprint(publicJwk = currentPublicJwk) {
    if (!publicJwk) return 'not configured';
    const canonical = JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y });
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
    return [...new Uint8Array(hash)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('').match(/.{4}/g).join(' ');
  }

  function clearMemory() { currentUserId = null; currentPrivateKey = null; currentPublicJwk = null; }
  return { ensureIdentity, encryptFor, decryptFromMe, decryptWithPrivateKey, encryptLocalData, decryptLocalData, fingerprint, clearMemory };
})();
