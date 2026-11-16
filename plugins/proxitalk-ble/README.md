# ProxiTalk BLE transport roadmap

The native implementation is `android/app/src/main/java/com/proxitalk/app/BleMeshService.java`, not a Capacitor plugin. The app uses a narrowly scoped `window.ProxiTalkNative` WebView bridge.

## Implemented prototype

- User-initiated, foreground BLE advertisement/scanning and GATT server/client connections for a ProxiTalk service UUID.
- Runtime permission flow for Android 12+ nearby devices (and legacy Android location permission where required).
- A foreground notification while the radio service is active.
- Bounded fragmentation/reassembly for short-lived recipient-key-encrypted JSON envelopes; plaintext `text` and `body` fields are rejected.
- Anonymous peer count only; raw device addresses and advertised names are not exposed to the web layer.

This is a **radio carrier prototype**, not an authenticated chat transport. It has no sender identity proof, recipient-delivery acknowledgement, durable queue, routing, multi-hop relay, or cloud fallback.

## Bridge methods

```js
ProxiTalkNative.startBleDiscovery() // request permissions and start opt-in BLE/GATT service
ProxiTalkNative.stopBleDiscovery()  // stop the foreground service
ProxiTalkNative.getBleStatus()      // JSON status: running, peer/connection counts, error
ProxiTalkNative.sendBlePacket(json) // queue a validated encrypted envelope to connected peers
ProxiTalkNative.drainBlePackets()   // take complete validated encrypted envelopes from GATT
```

`js/ble.js` wraps these methods as `ProxiBLE`. On web builds it reports native BLE unavailable. `sendBlePacket` returning `ok` means queued for the current radio session—not delivered to the recipient.

## Next implementation checklist

- [ ] Test discovery, GATT transfer, frame reassembly, and permission/error states on two Android 13 devices.
- [ ] Design sender authentication that verifies offline; E2E recipient encryption alone does not authenticate the sender.
- [ ] Integrate only authenticated packets into chat and return recipient-decryption receipts.
- [ ] Add deduplication, encrypted durable store-and-forward, hop/expiry enforcement, and cloud fallback.
- [ ] Test interrupted/reordered/oversized packets, force-stop/background behavior, battery impact, and online fallback.

Do not add raw message plaintext to the native bridge or BLE advertisement. Keep recipient-only encryption in the Web Crypto layer and treat BLE as an untrusted carrier. Android-only first; iOS is a separate future decision.
