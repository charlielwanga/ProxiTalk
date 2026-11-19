# ProxiTalk — early-access encrypted messaging

ProxiTalk has **one-to-one, internet-delivered encrypted text** and a beta **voice/video calling path** for signed-in contacts. Users sign in with Google or email magic link, create a ProxiTalk ID, look up another ID, and message through an authenticated Supabase mailbox. Calls use browser WebRTC with E2E-encrypted, device-signed signaling through a short-lived Supabase mailbox; media is sent directly peer-to-peer using DTLS-SRTP.

This is an early-access implementation, **not yet production-ready**. Calls are beta and have not been validated between two physical Android devices or across real mobile networks. The complete two-account acceptance matrix, independent cryptographic/security review, TURN relay, and production operations review remain incomplete. Do not use it for emergencies or high-risk communication.

## Current scope

- Google OAuth (PKCE) and email magic-link sign-in, plus a public ProxiTalk ID directory. Google sign-in is enabled in the configured Supabase project.
- One-to-one text messages over the internet. Browser Web Crypto uses ephemeral P-256 ECDH, HKDF-SHA-256, and AES-256-GCM; the server receives an encrypted envelope.
- Beta one-to-one audio/video calls between saved contacts. Call SDP/ICE signaling is recipient-key encrypted and device-signed; audio/video uses direct WebRTC DTLS-SRTP. Both people must be signed in, online, and have the app open. Incoming calls are polled in the foreground, not delivered by push. Only a public STUN server is configured—there is no TURN relay—so some carriers, NATs, or firewalls will prevent connection. Calls have not completed physical-device/network acceptance testing.
- Recipient polling and authenticated row-level security for directory and mailbox records. Messages expire from the pending query after 14 days; expired-row cleanup/retention automation is not yet configured.
- Non-extractable device ECDH and ECDSA private keys are stored in IndexedDB; the public keys are provisioned in the directory. Android's experimental one-hop BLE text path signs the packet and verifies the sender against that directory key before decrypting/displaying it. Signed-in local chat history is encrypted at rest with a device-derived key; local contacts/IDs remain in browser storage.
- Empty-by-default installation; there are no seeded/demo accounts, contacts, or conversations.
- Offline use permits local drafts only. A draft is not delivered automatically when connectivity returns.

## Not available

- Android has an experimental opt-in foreground BLE/GATT one-hop text path. If online mailbox delivery fails while nearby BLE is enabled, it may hand off a recipient-key-encrypted, ECDSA-signed packet. Handoff is not recipient delivery confirmation; packets are not relayed or durably stored, and physical two-device testing is still required. Web BLE, Wi-Fi Direct, and iOS are not implemented.
- Encrypted groups, file/photo/audio-message delivery, SMS, push call notifications, read receipts, or actual emergency/SOS broadcasts. Beta calls are direct WebRTC only and are not supported as a reliable or emergency communication path.
- Account/device key recovery, multi-device history, key rotation, and automatic identity verification. A new browser/device cannot decrypt messages for an existing device key.
- Abuse reporting/moderation, rate limits for message creation, support, observability, backups/retention operations, or a reviewed incident-response process.

Compare a contact's key fingerprint out of band before relying on identity. The service can expose directory metadata (ProxiTalk IDs, display names, public keys, sender/recipient IDs, and message timing). Browser compromise, malicious updates, or a compromised endpoint can expose message contents. This code has not had an independent security audit.

## Run locally

```sh
npm run build:android
npm test
npm run preview
```

Open `http://localhost:8000`. Use `npm run dev` for the root site. `dist/` is the deployable static bundle. The service worker caches only the application shell and never caches auth/API requests.

## Deployment and backend

- GitHub Pages is the current hosting target; root `index.html` is served by the repository's Pages configuration. Vercel can use `npm run build` and `dist` as its output directory.
- The browser uses the Supabase **publishable** key in `js/config.js`. That key is intended to be public. Never add a secret/service-role key to client code. Database RLS policies—not key secrecy—must protect user data.
- Supabase project `oxmxffftlpbpbydphhpv` (`ProxiTalk`) is the configured backend. The authenticated directory/mailbox, nullable signing-key, and encrypted call-signaling schema migrations are applied there and tracked under `supabase/migrations/`. The prior project was not data-migrated; existing accounts, mailbox rows, and device-bound keys remain on their original backend.
- Supabase Auth's site URL and redirect allow-list include the current GitHub Pages URL and Android callback URI. Email confirmation remains enabled. Configure and verify a production SMTP sender before inviting general users; the default Supabase mailer is not an appropriate production mail-delivery setup.
- Google sign-in is enabled in the Supabase provider for the configured project. Its Google Cloud OAuth authorized redirect URI is `https://oxmxffftlpbpbydphhpv.supabase.co/auth/v1/callback`. Supabase Auth allows `https://charlielwanga.github.io/ProxiTalk/`, `http://localhost:8000/**`, and `com.proxitalk.app://auth/callback`. Review the Google provider's nonce-check setting and keep nonce validation enabled for production.
- `.github/workflows/android-debug-apk.yml` builds a sideloadable debug APK on pushes to this branch or manual dispatch. CI builds have succeeded; artifacts are for device testing only, not release-signed builds. Do not uninstall the currently installed app to apply a test APK unless its device-bound key has been safely migrated.

## Verification and release gates

`npm test` checks JavaScript parsing, empty-by-default behavior, encryption-path wiring, SQL/RLS policy presence, feature disclosures, and static-bundle/service-worker completeness. These are code-level checks only; they do **not** prove live signup, two-user message delivery, confidentiality, abuse resistance, or operational readiness.

Before a public production launch:

1. Configure production SMTP, CAPTCHA/abuse controls, allowed origins/redirects, support contact, and service monitoring.
2. Complete a two-real-account test on separate browsers/devices: email verification, profile creation, ID lookup, encrypted send/receive, expiry, sign-out, refresh, and unauthorized-access attempts. Do this without demo accounts or seeded messages.
3. Obtain an independent cryptographic/security review; define key verification, rotation, recovery, deletion, retention, and incident response.
4. Add server-side quotas/abuse protection and scheduled expiration cleanup; test RLS and grants with anonymous, unrelated authenticated, sender, and recipient identities.
5. Product direction is **hybrid online + offline mesh**. Android 13/API 33 is the confirmed first device target. The online one-to-one path has been exercised between Web and Android. Android now has experimental signed, recipient-encrypted one-hop text send/receive integrated with chats, but it depends on online-directory signing keys and remains unvalidated on physical devices. Next validate two Android 13 devices; then design recipient acknowledgements and bounded encrypted store-and-forward/relay with replay and abuse controls. Do not claim reliable offline delivery. iOS remains a separate later platform decision.
6. Add accessibility/device/browser testing, backups and restore drills, privacy/legal review, release monitoring, and a user-support process.

The Android host is still partial, and this environment does not have Java/Gradle to verify a native release build.
