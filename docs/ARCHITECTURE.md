# ProxiTalk architecture and launch boundary

## Web and online messaging

The static web app is built into `dist/` by `scripts/build-site.mjs` and hosted on GitHub Pages. Authenticated users have one directory identity and can send one-to-one text as a recipient-key-encrypted envelope through the Supabase mailbox. The server stores ciphertext only; participant-scoped RLS governs mailbox access. The app confirms a send only when Supabase returns the inserted message-row ID. Recipients poll for pending rows, decrypt locally, then acknowledge them.

Browser sessions persist in the current browser profile. Device ECDH private keys are non-extractable CryptoKeys in IndexedDB; signed-in chat history is encrypted with a device-derived key. These keys are not currently recoverable or portable to another browser/device. Clearing site/app data can permanently remove the key.

## Android host and BLE discovery

The Android module serves bundled assets through `WebViewAssetLoader` and limits the native JavaScript bridge to the app origin. Email PKCE redirects use a narrowly scoped custom URI. The opt-in foreground BLE service advertises/scans a ProxiTalk UUID and opens a GATT characteristic for bounded packet transfer. It reports only an anonymous peer count; device addresses/names stay native.

The GATT prototype accepts short-lived, recipient-key-encrypted JSON envelopes and fragments/reassembles them under a byte cap. It rejects plaintext text/body fields. It does **not** authenticate sender identity, route chat messages, acknowledge recipient decryption, durably store packets, relay them, or fall back to cloud. Do not present this carrier as offline messaging. Android 13 is the first native target; iOS is not scoped for this milestone.

## Security and operational boundary

- The browser uses a public Supabase publishable key. No service-role key belongs in client code. RLS—not key secrecy—protects user data.
- E2E message ciphertext uses ephemeral P-256 ECDH, HKDF-SHA-256, and AES-256-GCM. No independent cryptographic review has been performed.
- Directory IDs, names, public keys, sender/recipient IDs, and timing are visible to the service. Browser compromise or malicious client updates can expose plaintext.
- Production SMTP, CAPTCHA/abuse prevention, server-side quotas, retention cleanup, backups/restore, monitoring, support, privacy/legal review, and incident response are incomplete.
- The Android APK workflow produces debug test builds, not store-release packages. Do not uninstall the current app or clear its data until a safe signing/update or key-migration strategy exists.

## Remaining implementation sequence

1. Validate opt-in BLE/GATT transfer on two Android 13 devices, including permission denial, Bluetooth disabled, interrupted/reordered frames, and oversize rejection.
2. Design offline sender authentication. Recipient-only encryption provides confidentiality but not sender authenticity.
3. Integrate verified packet send/receive into chat and add recipient-decryption acknowledgements.
4. Add deduplication, encrypted durable store-and-forward, hop/expiry limits, cloud fallback, and cleanup.
5. Complete the two-real-account acceptance matrix, independent security review, and production operations before launch.
