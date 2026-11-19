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
  let currentSigningPrivateKey = null;
  let currentSigningPublicJwk = null;

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

  async function generateSigningIdentity() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk };
  }

  async function ensureIdentity(userId) {
    if (!userId) throw new Error('Authenticated user ID is required for key storage');
    if (currentUserId === userId && currentPrivateKey && currentPublicJwk && currentSigningPrivateKey && currentSigningPublicJwk) return currentPublicJwk;
    const saved = await readIdentity(userId);
    let record;
    if (saved) {
      currentPrivateKey = saved.privateKey;
      currentPublicJwk = saved.publicJwk;
      record = { ...saved };
    } else {
      const identity = await generateIdentity();
      currentPrivateKey = identity.privateKey;
      currentPublicJwk = identity.publicJwk;
      record = { userId, privateKey: identity.privateKey, publicJwk: identity.publicJwk, createdAt: Date.now() };
    }
    if (record.signingPrivateKey && record.signingPublicJwk) {
      currentSigningPrivateKey = record.signingPrivateKey;
      currentSigningPublicJwk = record.signingPublicJwk;
    } else {
      // Upgrade existing device identity without replacing the non-exportable ECDH key.
      const signing = await generateSigningIdentity();
      currentSigningPrivateKey = signing.privateKey;
      currentSigningPublicJwk = signing.publicJwk;
      record.signingPrivateKey = signing.privateKey;
      record.signingPublicJwk = signing.publicJwk;
      await saveIdentity(record);
    }
    currentUserId = userId;
    return currentPublicJwk;
  }

  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  async function signPayload(payload) {
    if (!currentSigningPrivateKey) throw new Error('Device signing key is not unlocked');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, currentSigningPrivateKey,
      encoder.encode(canonicalJson(payload)),
    );
    return toB64(new Uint8Array(signature));
  }
  async function verifyPayload(publicJwk, payload, signature) {
    if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || !signature) return false;
    try {
      const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signature),
        encoder.encode(canonicalJson(payload)),
      );
    } catch (_) { return false; }
  }
  function getSigningPublicKey() { return currentSigningPublicJwk; }
  async function signPacket(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.signature || packet.sender_signing_key) {
      throw new Error('Packet must be an unsigned object without an embedded signing key');
    }
    const payload = { ...packet, sender_signing_key: currentSigningPublicJwk };
    return { ...payload, signature: await signPayload(payload) };
  }
  async function verifyPacket(packet, trustedSigningPublicJwk) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !trustedSigningPublicJwk) return false;
    const includedKey = packet.sender_signing_key;
    if (!includedKey || includedKey.kty !== trustedSigningPublicJwk.kty || includedKey.crv !== trustedSigningPublicJwk.crv
      || includedKey.x !== trustedSigningPublicJwk.x || includedKey.y !== trustedSigningPublicJwk.y) return false;
    const payload = { ...packet };
    delete payload.signature;
    // route_hops is mutable transport metadata; the immutable sender packet remains signed.
    delete payload.route_hops;
    return verifyPayload(trustedSigningPublicJwk, payload, packet.signature);
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

  function clearMemory() {
    currentUserId = null;
    currentPrivateKey = null;
    currentPublicJwk = null;
    currentSigningPrivateKey = null;
    currentSigningPublicJwk = null;
  }
  return {
    ensureIdentity, getSigningPublicKey, signPayload, verifyPayload, signPacket, verifyPacket,
    encryptFor, decryptFromMe, decryptWithPrivateKey, encryptLocalData, decryptLocalData,
    fingerprint, clearMemory,
  };
})();
