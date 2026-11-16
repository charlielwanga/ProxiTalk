# ProxiTalk BLE transport roadmap

The current native implementation is `android/app/src/main/java/com/proxitalk/app/BleMeshService.java`, not a Capacitor plugin. The app uses a narrowly scoped `window.ProxiTalkNative` WebView bridge.

## Implemented first milestone

- User-initiated, foreground BLE advertisement and scanning of one ProxiTalk service UUID.
- Runtime permission flow for Android 12+ nearby devices (and legacy Android location permission where required).
- A foreground notification while discovery is active.
- Anonymous peer count only; raw device addresses and advertised names are not exposed to the web layer.

This milestone is **discovery only**. There is no GATT connection, transfer, message relay, or offline delivery claim.

## Bridge methods

```js
ProxiTalkNative.startBleDiscovery() // request permissions and start opt-in discovery
ProxiTalkNative.stopBleDiscovery()  // stop the foreground discovery service
ProxiTalkNative.getBleStatus()      // JSON status: running, scan/advertise, peerCount, error
```

`js/ble.js` wraps these methods as `ProxiBLE`. On web builds it reports native discovery as unavailable.

## Next implementation checklist

- [ ] Test discovery and permission/error states on two Android 13 devices.
- [ ] Review an opaque packet envelope (recipient, expiry, TTL, unique ID, ciphertext).
- [ ] Add a GATT service/characteristic and bounded, validated fragmentation/reassembly.
- [ ] Add deduplication, encrypted store-and-forward, and recipient acknowledgements.
- [ ] Test interrupted/reordered packets, force-stop/background behavior, battery impact, and cloud fallback.

Do not add raw message plaintext to the native bridge or BLE advertisement. Keep recipient-only encryption in the Web Crypto layer and treat BLE as an untrusted carrier. Android-only first; iOS is a separate future decision.
