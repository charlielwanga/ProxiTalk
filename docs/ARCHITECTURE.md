# ProxiTalk architecture and launch boundary

## Web and online messaging

The static web app is built into `dist/` by `scripts/build-site.mjs` and hosted on GitHub Pages. Sign-in supports Supabase email PKCE and Google OAuth PKCE. Authenticated users have one directory identity and can send one-to-one text as a recipient-key-encrypted envelope through the Supabase mailbox. The server stores ciphertext only; participant-scoped RLS governs mailbox access. The app confirms a send only when Supabase returns the inserted message-row ID. Recipients poll for pending rows, decrypt locally, then acknowledge them.

Beta audio/video calls use browser WebRTC. Call offer/answer/ICE payloads are recipient-key encrypted and device-signed before they are placed in the participant-RLS call signaling table. The table keeps only short-lived, metadata-bearing signaling rows; media does not pass through Supabase. WebRTC uses DTLS-SRTP direct media with a public STUN endpoint. There is no TURN relay, push ringing, or background-call service, so call connectivity is network-dependent and calls are foreground-only.

Browser sessions persist in the current browser profile. Device ECDH and ECDSA private keys are non-extractable CryptoKeys in IndexedDB; signed-in chat history is encrypted with a device-derived key. Directory-published ECDSA public keys authenticate experimental Android BLE packets. BLE messages are accepted only for the signed-in recipient, only after sender identity/signature verification against the directory key, and only after recipient decryption. These keys are not currently recoverable or portable to another browser/device. Clearing site/app data can permanently remove the keys.

## Android host and BLE discovery

The Android module serves bundled assets through `WebViewAssetLoader` and limits the native JavaScript bridge to the app origin. Email and Google PKCE redirects use a narrowly scoped custom URI. WebView camera/microphone requests are granted only for the bundled app origin and only after the corresponding Android runtime permissions are granted. The opt-in foreground BLE service advertises/scans a ProxiTalk UUID and opens a GATT characteristic for bounded packet transfer. It reports only an anonymous peer count; device addresses/names stay native.

The GATT carrier accepts bounded JSON envelopes containing recipient-key-encrypted content, an ECDSA public signing key, and signature; it fragments/reassembles under a byte cap. Java validates structure/expiry/size, while the authenticated WebView verifies sender key against the directory and decrypts content before chat insertion. If cloud delivery fails while BLE is running, the app can hand off a signed one-hop text packet; the sender sees only a local handoff state, never a delivery receipt. There is no durable packet storage, relay, or automatic retry. This is experimental and must not be presented as reliable offline delivery. Android 13 is the first native target; iOS is not scoped for this milestone.

## Security and operational boundary

- The browser uses a public Supabase publishable key. No service-role key belongs in client code. RLS—not key secrecy—protects user data.
- E2E message ciphertext uses ephemeral P-256 ECDH, HKDF-SHA-256, and AES-256-GCM. No independent cryptographic review has been performed.
- Directory IDs, names, public keys, sender/recipient IDs, and timing are visible to the service. Browser compromise or malicious client updates can expose plaintext.
- Production SMTP, CAPTCHA/abuse prevention, server-side quotas, retention cleanup, backups/restore, monitoring, support, privacy/legal review, and incident response are incomplete.
- The Android APK workflow produces debug test builds, not store-release packages. Do not uninstall the current app or clear its data until a safe signing/update or key-migration strategy exists.

## Remaining implementation sequence

1. Validate signed opt-in BLE/GATT chat on two Android 13 devices, including permission denial, Bluetooth disabled, online fallback, sender-key mismatch, tampering, interrupted/reordered frames, expiry, and oversize rejection.
2. Design and implement recipient-decryption acknowledgements with replay-resistant semantics; until then, keep BLE handoff distinct from delivery.
3. Add encrypted bounded durable store-and-forward and multi-hop relay only with explicit hop, TTL, quota, replay, and abuse controls.
4. Define key rotation, recovery, and multi-device identity policy before widening BLE availability.
5. Complete the two-real-account acceptance matrix, independent security review, and production operations before launch.
