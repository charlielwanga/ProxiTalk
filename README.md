# ProxiTalk — local-first messaging prototype

ProxiTalk explores a future offline-first messenger for communities with unreliable connectivity. **This build is a local UI preview, not a working messaging service.** It does not send messages to other people, establish Bluetooth/Wi-Fi mesh links, provide end-to-end encryption, or deliver emergency alerts. Do not use it for sensitive communication or emergencies.

The web preview intentionally starts with no sample users or conversations. Contacts, draft messages, and attachments are saved in the current browser's local storage only. A message composer confirmation explicitly says that a message was not sent.

## Run locally

```sh
npm ci
npm test
npm run build
npm run preview
```

Then open `http://localhost:8000`. The deployable static output is `dist/`.

## GitHub Pages

A GitHub Actions workflow builds and deploys the static site from `main` or this work branch. Pages must be enabled for the repository with **GitHub Actions** as the build source. The static site is also compatible with Vercel (`npm run build`, output directory `dist`); `vercel.json` adds basic browser security headers.

## What currently works

- Empty-by-default local contact and conversation interface.
- Draft text and attachments are stored in this browser only.
- Installable/offline web shell for the local interface.
- Static build and smoke tests.

## Not implemented / intentionally disabled

- Real Bluetooth advertising, scanning, peer discovery, and store-and-forward delivery. Web Bluetooth browser APIs alone do not provide the required background mesh behavior; the Android bridge remains a stub.
- Authenticated account onboarding, cloud sync, per-user access control, device key exchange, recipient-verifiable E2E encryption, and multi-device message history.
- Voice calls, SMS delivery/provider integration, and actual emergency broadcast.
- Android release signing and Play Store readiness.

The earlier UI prototype used synthetic contacts, simulated peers, fabricated delivery confirmations, and open anonymous database policies. Those values have been removed from the served build. The Supabase tables have been locked down and its gateway/SMS functions disabled until authentication and authorization are implemented. No Supabase credentials or network client are shipped in the browser build.

## Current deployment boundary

Hosting this static bundle makes the **preview** public; it does not make ProxiTalk's transport or backend production-ready. Before real users or messages, implement and review account/identity flows, least-privilege RLS policies, key exchange and recovery, native Android BLE advertising/foreground relaying, privacy/retention rules, abuse protection, and end-to-end device tests.
