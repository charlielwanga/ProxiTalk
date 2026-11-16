/* Recipient-verifiable end-to-end encryption is not implemented.
 * This placeholder intentionally refuses to encrypt rather than falling back
 * to reversible obfuscation or presenting a device-local key as E2E security.
 */
const ProxiCrypto = Object.freeze({
  enabled: false,
  async encrypt() { throw new Error('Messaging encryption is not configured'); },
  async decrypt() { throw new Error('Messaging decryption is not configured'); },
  async fingerprint() { return 'not configured'; },
});
