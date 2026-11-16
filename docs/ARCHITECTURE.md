# ProxiTalk architecture and launch boundary

## Web and online messaging

The static web app is built into `dist/` by `scripts/build-site.mjs` and hosted on GitHub Pages. Authenticated users have one directory identity and can send one-to-one text as a recipient-key-encrypted envelope through the Supabase mailbox. The server stores ciphertext only; participant-scoped RLS governs mailbox access. The app confirms a send only when Supabase returns the inserted message-row ID. Recipients poll for pending rows, decrypt locally, then acknowledge them.

Browser sessions persist in the current browser profile. Device ECDH private keys are non-extractable CryptoKeys in IndexedDB; signed-in chat history is encrypted with a device-derived key. These keys are not currently recoverable or portable to another browser/device. Clearing site/app data can permanently remove the key.

## Android host and BLE discovery

The Android module serves bundled assets through `WebViewAssetLoader` and limits the native JavaScript bridge to the app origin. Email PKCE redirects use a narrowly scoped custom URI. The new BLE milestone is opt-in and foreground-only: `BleMeshService` advertises a service UUID and scans for nearby devices using Android BLE permissions. It reports a count only; it does not expose device addresses/names to JavaScript.

**There is no GATT connection, packet transfer, message relay, or store-and-forward yet.** BLE discovery does not mean messages can be sent offline. Android 13 is the confirmed first native target; iOS is not scoped for this milestone.

## Security and operational boundary

- The browser uses a public Supabase publishable key. No service-role key belongs in client code. RLS—not key secrecy—protects user data.
- E2E message ciphertext uses ephemeral P-256 ECDH, HKDF-SHA-256, and AES-256-GCM. No independent cryptographic review has been performed.
- Directory IDs, names, public keys, sender/recipient IDs, and timing are visible to the service. Browser compromise or malicious client updates can expose plaintext.
- Production SMTP, CAPTCHA/abuse prevention, server-side quotas, retention cleanup, backups/restore, monitoring, support, privacy/legal review, and incident response are incomplete.
- The Android APK workflow produces debug test builds, not store-release packages. Do not uninstall the current app or clear its data until a safe signing/update or key-migration strategy exists.

## Remaining implementation sequence

1. Validate opt-in BLE discovery on two Android 13 devices, including permissions denied/off and Bluetooth disabled.
2. Review a bounded opaque-packet protocol: recipient identity, expiry, TTL/hop limit, deduplication ID, and acknowledgements. Keep recipient-only encryption.
3. Implement GATT exchange and bounded fragmentation/reassembly; test both directions and interruption.
4. Add encrypted local store-and-forward and delivery confirmation, then cloud fallback and expiry cleanup.
5. Complete the two-real-account auth/message acceptance matrix, independent security review, and production operations before launch.
