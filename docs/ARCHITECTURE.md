# ProxiTalk current architecture / launch boundary

## Web preview

The deployable site is a static HTML/CSS/JavaScript app, built into `dist/` by `scripts/build-site.mjs`. The only active app modules are local storage, the non-simulating transport status view, and UI logic. A service worker caches only the static shell and never fabricates network delivery.

Contacts, drafts, and locally selected attachment data are browser-local. There is no login, cross-device sync, or message delivery in this build. UI status explicitly identifies drafts as unsent.

## Security actions already taken

- Dropped the anonymous `proxitalk_open_all` RLS policies from all seven public tables and revoked table privileges from `PUBLIC`, `anon`, and `authenticated`; RLS is enabled and forced.
- Replaced the two Supabase Edge Function bodies with disabled responses and turned on JWT verification. They must not be called as messaging services until real authentication and authorization exist.
- Excluded Supabase, Bluetooth, Wi-Fi Direct, calls, SMS, and crypto modules from the deployed static bundle.
- Added restrictive security headers for the Vercel static build.

The schema and functions are infrastructure scaffolding only. A privileged operator can still access the database; production policies must be designed around verified users, device identity, packet recipients, group membership, retention, and consent before re-enabling them.

## Planned system (not implemented)

Future design goals include native Android BLE advertising and foreground relaying, peer discovery and authenticated store-and-forward packets, secure per-device identity/key exchange, a gateway service with user-scoped RLS, group/SOS semantics, and verified delivery acknowledgements. These are not features of the current build. The Android bridge and files under `js/ble.js`, `js/wifi-direct.js`, `js/calls.js`, `js/sms-bridge.js`, and `js/crypto.js` are not loaded by the web app.
