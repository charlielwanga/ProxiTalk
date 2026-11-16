# ProxiTalk — Google Play Store Listing

## Short description (80 chars)
Offline mesh messenger — chat without internet via Bluetooth phone-to-phone relay.

## Full description
**ProxiTalk — WhatsApp without the internet.**

When the internet goes down, ProxiTalk keeps you connected. Every phone with the app becomes a node on a Bluetooth mesh network, relaying messages phone-to-phone until they reach the recipient. Phones with internet act as gateways to the ProxiTalk cloud.

🔒 End-to-end encrypted (AES-256)
📡 Works fully offline — Bluetooth mesh relay
☁️ Cloud backup via gateway phones
🆘 SOS emergency broadcast to all nearby phones
🎤 Voice notes, 📷 photos, 📎 files, 👥 groups
📞 Mesh voice calls
🌍 English, Luganda, Kiswahili
🔋 Battery-aware relay mode

Built for communities in Uganda and across East Africa where connectivity is fragile — markets, campuses, villages, and disaster zones.

## Category
Communication

## Tags
offline messenger, mesh network, bluetooth chat, no internet, emergency, Uganda, Africa

## Content rating
Everyone

## Privacy policy (summary)
ProxiTalk is end-to-end encrypted. Message content is encrypted on your device before entering the mesh and can only be decrypted by the recipient. Relay phones forward ciphertext they cannot read. Gateway sync stores only ciphertext in the cloud. No ads, no trackers, no data selling.

## Screenshots checklist
- [ ] Chat screen (dark theme)
- [ ] Mesh network map with live packets
- [ ] Outage mode banner
- [ ] SOS broadcast screen
- [ ] Language switcher (Luganda)
- [ ] Voice call screen

## Feature graphic
1024 × 500 — ProxiTalk logo + mesh map visual + "Chat without internet" tagline

## Release checklist
- [ ] Bump versionCode in android/build.gradle
- [ ] Sign with upload keystore (scripts/signing.md)
- [ ] Build release AAB: `./gradlew bundleRelease`
- [ ] Test on 3+ physical devices (BLE mesh needs real phones)
- [ ] Data safety form: "Messages encrypted in transit, not collected"
