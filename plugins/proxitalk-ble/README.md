# ProxiTalk BLE Plugin (Capacitor)

Native Bluetooth Low Energy mesh transport for the Android APK.

## Why a custom plugin?
The community `bluetooth-le` plugin handles scanning/connecting, but ProxiTalk needs:
- **Background advertising** — your phone must be discoverable as a relay even when the app is backgrounded
- **GATT server** — accept incoming packets from peers
- **Chunked transfer** — 180-byte BLE MTU reassembly (handled in `js/ble.js`)

## API (exposed as `window.ProxiTalkNative`)
```js
ProxiTalkNative.startScan()          // discover nearby ProxiTalk peers
ProxiTalkNative.stopScan()
ProxiTalkNative.sendPacket(json)     // write packet to connected peer
ProxiTalkNative.wifiDirectSend(json) // Wi-Fi Direct fallback
ProxiTalkNative.getDeviceId()        // stable node ID
```

## Implementation checklist
- [ ] `BleMeshService.kt` — foreground service with `BluetoothLeAdvertiser`
- [ ] GATT server with service `0xFEAA`, characteristic `0xFEAB` (notify + write)
- [ ] Foreground notification: "ProxiTalk relay active 📡"
- [ ] Battery-aware: pause advertising when battery < 20% (unless charging)
- [ ] Wire `MainActivity.java` bridge methods to the service

See `android/app/src/main/java/com/proxitalk/app/MainActivity.java` for the bridge stub.
