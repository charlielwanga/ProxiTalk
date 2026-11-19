package com.proxitalk.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/** Explicitly opt-in BLE transport with bounded opaque packet persistence and relay. */
public final class BleMeshService extends Service {
    public static final UUID SERVICE_UUID = UUID.fromString("7dd9a5d0-62a5-4a17-9e16-5f50b331a101");
    public static final UUID PACKET_CHARACTERISTIC_UUID = UUID.fromString("7dd9a5d1-62a5-4a17-9e16-5f50b331a101");
    private static final String TAG = "ProxiTalkBLE";
    private static final String CHANNEL_ID = "proxitalk_nearby";
    private static final int NOTIFICATION_ID = 4107;
    private static final int MAX_PACKET_BYTES = 16 * 1024;
    private static final int MAX_SEEN_PACKETS = 256;
    private static final int MAX_PEERS = 3;
    private static final int MAX_PENDING_PER_PEER = 16;
    private static final int FRAME_HEADER_BYTES = 8;
    private static final int FRAME_MAGIC_0 = 0x50;
    private static final int FRAME_MAGIC_1 = 0x54;
    private static final long PEER_TIMEOUT_MS = 30_000L;

    private static final Map<String, Long> PEERS = new HashMap<>();
    private static final Map<String, Long> SERVER_PEERS = new HashMap<>();
    private static final AtomicInteger NEXT_TRANSFER_ID = new AtomicInteger(1);
    private static volatile BleMeshService instance;
    private static volatile boolean running = false;
    private static volatile boolean scanning = false;
    private static volatile boolean advertising = false;
    private static volatile String error = "";
    private static volatile String localUserId = "";
    private static volatile boolean relayEnabled = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private BlePacketStore packetStore;
    private final Map<String, Connection> connections = new HashMap<>();
    private final Map<String, String> connecting = new HashMap<>();
    private final Map<String, Assembly> assemblies = new HashMap<>();
    private BluetoothManager bluetoothManager;
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer gattServer;
    private BluetoothGattService gattService;
    private BluetoothGattCharacteristic packetCharacteristic;
    private ScanCallback scanCallback;
    private AdvertiseCallback advertiseCallback;
    private boolean scanningInstance;
    private boolean advertisingInstance;

    private final Runnable expirePeers = new Runnable() {
        @Override public void run() {
            long cutoff = System.currentTimeMillis() - PEER_TIMEOUT_MS;
            synchronized (PEERS) { PEERS.entrySet().removeIf(entry -> entry.getValue() < cutoff); }
            synchronized (SERVER_PEERS) { SERVER_PEERS.entrySet().removeIf(entry -> entry.getValue() < cutoff); }
            synchronized (assemblies) { assemblies.entrySet().removeIf(entry -> System.currentTimeMillis() - entry.getValue().createdAt > PEER_TIMEOUT_MS); }
            if (packetStore != null) packetStore.prune();
            if (running) handler.postDelayed(this, 5_000L);
        }
    };

    private static final class Assembly {
        final int transferId;
        final int total;
        final byte[][] chunks;
        int received;
        int byteCount;
        final long createdAt = System.currentTimeMillis();
        Assembly(int transferId, int total) { this.transferId = transferId; this.total = total; this.chunks = new byte[total][]; }
    }

    private static final class Connection {
        final BluetoothGatt gatt;
        final String address;
        final ArrayDeque<String> queue = new ArrayDeque<>();
        final LinkedHashSet<String> sentIds = new LinkedHashSet<>();
        BluetoothGattCharacteristic characteristic;
        int mtu = 23;
        byte[][] frames;
        int frameIndex;
        String packetId;
        boolean discoveryStarted;
        Connection(BluetoothGatt gatt, String address) { this.gatt = gatt; this.address = address; }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        packetStore = new BlePacketStore(this);
        relayEnabled = getSharedPreferences("proxitalk_mesh", MODE_PRIVATE).getBoolean("relay_enabled", false);
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, makeNotification());
        startRadio();
        return START_NOT_STICKY;
    }

    private void startRadio() {
        if (!hasBluetoothPermissions()) {
            fail("Bluetooth permissions are missing. Stop and start discovery to grant them.");
            stopSelf();
            return;
        }
        bluetoothManager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bluetoothManager == null ? null : bluetoothManager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            fail("Bluetooth is unavailable or turned off.");
            stopSelf();
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (scanner == null || advertiser == null) {
            fail("This device does not support BLE scanning and advertising.");
            stopSelf();
            return;
        }
        try {
            openGattServer();
            startScanning();
            running = true;
            error = "";
            handler.removeCallbacks(expirePeers);
            handler.postDelayed(expirePeers, 5_000L);
        } catch (Exception exception) {
            fail("Could not start BLE packet transport: " + exception.getMessage());
            stopSelf();
        }
    }

    private void openGattServer() {
        gattServer = bluetoothManager.openGattServer(this, new BluetoothGattServerCallback() {
            @Override public void onServiceAdded(int status, BluetoothGattService service) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Could not initialize the BLE packet service (" + status + ").");
                    return;
                }
                startAdvertising();
            }

            @Override public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                try {
                    String address = device.getAddress();
                    synchronized (SERVER_PEERS) {
                        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                            if (!SERVER_PEERS.containsKey(address) && SERVER_PEERS.size() >= MAX_PEERS) {
                                if (gattServer != null) gattServer.cancelConnection(device);
                                return;
                            }
                            SERVER_PEERS.put(address, System.currentTimeMillis());
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            SERVER_PEERS.remove(address);
                            synchronized (assemblies) { assemblies.remove(address); }
                        }
                    }
                } catch (SecurityException exception) { fail("Android denied a nearby-device connection operation."); }
            }

            @Override public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattCharacteristic characteristic, boolean preparedWrite, boolean responseNeeded,
                    int offset, byte[] value) {
                boolean valid = !preparedWrite && offset == 0 && characteristic != null
                        && PACKET_CHARACTERISTIC_UUID.equals(characteristic.getUuid())
                        && value != null && value.length > FRAME_HEADER_BYTES && value.length <= 512;
                if (responseNeeded) {
                    try { gattServer.sendResponse(device, requestId,
                            valid ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH, 0, null); }
                    catch (SecurityException exception) { fail("Android denied a BLE packet response."); }
                }
                if (!valid) { fail("Rejected an invalid BLE packet frame."); return; }
                try { acceptFrame(device.getAddress(), value); }
                catch (SecurityException exception) { fail("Android denied access to the BLE peer address."); }
            }
        });
        if (gattServer == null) throw new IllegalStateException("BLE GATT server unavailable");
        gattService = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        packetCharacteristic = new BluetoothGattCharacteristic(PACKET_CHARACTERISTIC_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);
        gattService.addCharacteristic(packetCharacteristic);
        if (!gattServer.addService(gattService)) throw new IllegalStateException("Could not register the BLE GATT service");
    }

    private void startAdvertising() {
        if (advertiser == null || advertisingInstance) return;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW)
                .setConnectable(true)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                advertisingInstance = true;
                advertising = true;
                error = "";
            }
            @Override public void onStartFailure(int errorCode) {
                advertisingInstance = false;
                advertising = false;
                fail("BLE advertising failed (" + errorCode + ").");
            }
        };
        advertiser.startAdvertising(settings, data, advertiseCallback);
    }

    private void startScanning() {
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                .build();
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                if (result == null || result.getDevice() == null) return;
                try {
                    BluetoothDevice device = result.getDevice();
                    String address = device.getAddress();
                    synchronized (PEERS) { PEERS.put(address, System.currentTimeMillis()); }
                    connectPeer(device, address);
                } catch (SecurityException exception) { fail("Android denied access to nearby-device details."); }
            }
            @Override public void onScanFailed(int errorCode) {
                scanningInstance = false;
                scanning = false;
                fail("BLE scan failed (" + errorCode + ").");
            }
        };
        scanner.startScan(filters, settings, scanCallback);
        scanningInstance = true;
        scanning = true;
    }

    private void connectPeer(BluetoothDevice device, String address) {
        synchronized (connections) {
            if (connections.containsKey(address) || connecting.containsKey(address) || connections.size() >= MAX_PEERS) return;
            connecting.put(address, address);
        }
        BluetoothGattCallback callback = new BluetoothGattCallback() {
            private Connection state;
            @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    state = new Connection(gatt, address);
                    synchronized (connections) { connecting.remove(address); connections.put(address, state); }
                    boolean requested = false;
                    try { requested = gatt.requestMtu(185); } catch (SecurityException ignored) { }
                    if (!requested) beginServiceDiscovery(state);
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    synchronized (connections) { connecting.remove(address); connections.remove(address); }
                    try { gatt.close(); } catch (Exception ignored) { }
                }
            }
            @Override public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
                if (state == null) return;
                state.mtu = status == BluetoothGatt.GATT_SUCCESS ? Math.max(23, mtu) : 23;
                beginServiceDiscovery(state);
            }
            @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                if (state == null) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Could not discover the nearby packet service."); disconnect(state); return;
                }
                BluetoothGattService remote = gatt.getService(SERVICE_UUID);
                BluetoothGattCharacteristic characteristic = remote == null ? null : remote.getCharacteristic(PACKET_CHARACTERISTIC_UUID);
                if (characteristic == null) {
                    fail("Nearby device does not expose the ProxiTalk packet service."); disconnect(state); return;
                }
                state.characteristic = characteristic;
                handler.post(() -> queuePendingPackets(state));
            }
            @Override public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                if (state == null) return;
                handler.post(() -> {
                    if (status == BluetoothGatt.GATT_SUCCESS) writeNext(state);
                    else { fail("BLE packet frame write failed (" + status + ")."); disconnect(state); }
                });
            }
        };
        try { device.connectGatt(this, false, callback, BluetoothDevice.TRANSPORT_LE); }
        catch (SecurityException exception) {
            synchronized (connections) { connecting.remove(address); }
            fail("Android denied a BLE connection request.");
        }
    }

    private void beginServiceDiscovery(Connection connection) {
        if (connection.discoveryStarted) return;
        connection.discoveryStarted = true;
        try {
            if (!connection.gatt.discoverServices()) fail("Could not start GATT service discovery.");
        } catch (SecurityException exception) { fail("Android denied GATT service discovery."); }
    }

    private static JSONObject validatePacket(String json) {
        try {
            if (json == null || json.getBytes(StandardCharsets.UTF_8).length > MAX_PACKET_BYTES) return null;
            JSONObject packet = new JSONObject(json);
            String packetId = packet.optString("id");
            String senderId = packet.optString("sender_id");
            String recipientId = packet.optString("recipient_id");
            long createdAt = packet.optLong("created_at", 0);
            long expiresAt = packet.optLong("expires_at", 0);
            java.util.Iterator<String> packetKeys = packet.keys();
            while (packetKeys.hasNext()) {
                String key = packetKeys.next();
                if (!Arrays.asList("v", "id", "sender_id", "recipient_id", "created_at", "expires_at", "hops", "route_hops", "ciphertext", "sender_signing_key", "signature").contains(key)) return null;
            }
            int routeHops = packet.optInt("route_hops", 0);
            if (packet.optInt("v", 0) != 1 || packetId.length() > 80 || packetId.isEmpty()
                    || createdAt <= 0 || createdAt > System.currentTimeMillis() + 60_000L
                    || expiresAt <= System.currentTimeMillis() || expiresAt <= createdAt
                    || expiresAt > createdAt + 14L * 24 * 60 * 60 * 1000
                    || packet.optInt("hops", -1) < 0 || packet.optInt("hops", 13) > 12
                    || routeHops < 0 || routeHops > BlePacketStore.MAX_RELAY_HOPS) return null;
            packet.put("route_hops", routeHops);
            UUID.fromString(senderId);
            UUID.fromString(recipientId);
            UUID.fromString(packetId);
            JSONObject ciphertext = packet.optJSONObject("ciphertext");
            JSONObject ephemeral = ciphertext == null ? null : ciphertext.optJSONObject("epk");
            JSONObject senderSigningKey = packet.optJSONObject("sender_signing_key");
            String signature = packet.optString("signature");
            if (ciphertext == null || ephemeral == null || senderSigningKey == null || signature.length() < 40 || signature.length() > 256
                    || !signature.matches("[A-Za-z0-9+/=_-]+")) return null;
            java.util.Iterator<String> signingKeyKeys = senderSigningKey.keys();
            while (signingKeyKeys.hasNext()) {
                String key = signingKeyKeys.next();
                if (!Arrays.asList("kty", "crv", "x", "y", "ext", "key_ops").contains(key)) return null;
            }
            if (!"EC".equals(senderSigningKey.optString("kty")) || !"P-256".equals(senderSigningKey.optString("crv"))
                    || senderSigningKey.optString("x").isEmpty() || senderSigningKey.optString("y").isEmpty()) return null;
            java.util.Iterator<String> cipherKeys = ciphertext.keys();
            while (cipherKeys.hasNext()) {
                String key = cipherKeys.next();
                if (!Arrays.asList("v", "alg", "epk", "salt", "iv", "ct").contains(key)) return null;
            }
            java.util.Iterator<String> publicKeyKeys = ephemeral.keys();
            while (publicKeyKeys.hasNext()) {
                String key = publicKeyKeys.next();
                if (!Arrays.asList("kty", "crv", "x", "y", "ext", "key_ops").contains(key)) return null;
            }
            if (ciphertext.optInt("v", 0) != 1
                    || !"ECDH-P256/HKDF-SHA256/AES-256-GCM".equals(ciphertext.optString("alg"))
                    || !"EC".equals(ephemeral.optString("kty")) || !"P-256".equals(ephemeral.optString("crv"))
                    || ephemeral.optString("x").isEmpty() || ephemeral.optString("y").isEmpty()
                    || ciphertext.optString("salt").isEmpty() || ciphertext.optString("iv").isEmpty()
                    || ciphertext.optString("ct").isEmpty()) return null;
            return packet;
        } catch (Exception ignored) { return null; }
    }

    public static void setLocalIdentity(String userId) {
        if (userId == null || userId.isEmpty()) { localUserId = ""; return; }
        try { localUserId = UUID.fromString(userId).toString(); }
        catch (IllegalArgumentException ignored) { localUserId = ""; }
    }

    public static String setRelayEnabled(boolean enabled) {
        BleMeshService service = instance;
        if (service == null || !running) return "{\"ok\":false,\"error\":\"Start nearby BLE before changing relay settings.\"}";
        relayEnabled = enabled;
        service.getSharedPreferences("proxitalk_mesh", MODE_PRIVATE).edit().putBoolean("relay_enabled", enabled).apply();
        service.handler.post(() -> {
            if (enabled) service.queuePendingForAllConnections();
            else service.removeQueuedRelayPackets();
        });
        return "{\"ok\":true}";
    }

    public static String acknowledgePacket(String packetId) {
        BleMeshService service = instance;
        if (service == null || service.packetStore == null || packetId == null || packetId.length() > 80)
            return "{\"ok\":false}";
        service.packetStore.completePacket(packetId);
        return "{\"ok\":true}";
    }

    public static String enqueuePacket(String json) {
        JSONObject packet = validatePacket(json);
        if (packet == null) return "{\"ok\":false,\"error\":\"Invalid, expired, or unencrypted packet\"}";
        BleMeshService service = instance;
        if (!running || service == null || service.packetStore == null) return "{\"ok\":false,\"error\":\"Nearby packet transport is not running\"}";
        if (!service.packetStore.putPacket(packet, true, null))
            return "{\"ok\":false,\"error\":\"Nearby encrypted queue is full or storage is unavailable\"}";
        int connected = service.getConnectedPeerCount();
        service.handler.post(service::queuePendingForAllConnections);
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("state", connected > 0 ? "persisted_and_queued" : "persisted_waiting_for_peer");
            result.put("connectedPeerCount", connected);
            result.put("queuedPacketCount", service.packetStore.pendingCount());
            return result.toString();
        } catch (Exception ignored) { return "{\"ok\":true}"; }
    }

    private void queuePendingForAllConnections() {
        synchronized (connections) {
            for (Connection connection : connections.values()) queuePendingPackets(connection);
        }
    }

    private void queuePendingPackets(Connection connection) {
        if (packetStore == null || connection.characteristic == null) return;
        List<String> packets = packetStore.pendingForPeer(connection.address, relayEnabled, localUserId, MAX_PENDING_PER_PEER);
        for (String json : packets) {
            JSONObject packet = validatePacket(json);
            if (packet == null) continue;
            String id = packet.optString("id");
            if (!connection.sentIds.add(id)) continue;
            while (connection.sentIds.size() > MAX_SEEN_PACKETS) {
                java.util.Iterator<String> oldest = connection.sentIds.iterator();
                if (oldest.hasNext()) { oldest.next(); oldest.remove(); }
            }
            if (connection.queue.size() >= MAX_PENDING_PER_PEER) { connection.sentIds.remove(id); break; }
            connection.queue.addLast(packet.toString());
        }
        writeNext(connection);
    }

    private void removeQueuedRelayPackets() {
        synchronized (connections) {
            for (Connection connection : connections.values()) {
                java.util.Iterator<String> queued = connection.queue.iterator();
                while (queued.hasNext()) {
                    String json = queued.next();
                    try {
                        String id = new JSONObject(json).optString("id");
                        if (!packetStore.isOrigin(id)) {
                            queued.remove();
                            connection.sentIds.remove(id);
                        }
                    } catch (Exception ignored) { queued.remove(); }
                }
            }
        }
    }

    private void writeNext(Connection connection) {
        if (connection.characteristic == null || connection.frames != null) return;
        if (connection.queue.isEmpty()) return;
        String packetJson = connection.queue.pollFirst();
        JSONObject packet = validatePacket(packetJson);
        if (packet == null) { writeNext(connection); return; }
        connection.packetId = packet.optString("id");
        byte[] bytes = packetJson.getBytes(StandardCharsets.UTF_8);
        int payloadLimit = Math.max(1, connection.mtu - 3 - FRAME_HEADER_BYTES);
        int total = (bytes.length + payloadLimit - 1) / payloadLimit;
        if (total > 2048) { fail("Encrypted packet exceeds the GATT fragmentation limit."); connection.packetId = null; writeNext(connection); return; }
        int transferId = NEXT_TRANSFER_ID.getAndIncrement() & 0xffff;
        connection.frames = new byte[total][];
        connection.frameIndex = 0;
        for (int i = 0; i < total; i++) {
            int start = i * payloadLimit;
            int length = Math.min(payloadLimit, bytes.length - start);
            byte[] frame = new byte[FRAME_HEADER_BYTES + length];
            frame[0] = (byte) FRAME_MAGIC_0;
            frame[1] = (byte) FRAME_MAGIC_1;
            frame[2] = (byte) ((transferId >>> 8) & 0xff);
            frame[3] = (byte) (transferId & 0xff);
            frame[4] = (byte) ((i >>> 8) & 0xff);
            frame[5] = (byte) (i & 0xff);
            frame[6] = (byte) ((total >>> 8) & 0xff);
            frame[7] = (byte) (total & 0xff);
            System.arraycopy(bytes, start, frame, FRAME_HEADER_BYTES, length);
            connection.frames[i] = frame;
        }
        writeFrame(connection);
    }

    private void writeFrame(Connection connection) {
        if (connection.frames == null || connection.characteristic == null) return;
        if (connection.frameIndex >= connection.frames.length) {
            String completedId = connection.packetId;
            connection.frames = null;
            connection.packetId = null;
            if (packetStore != null) packetStore.markForwarded(completedId, connection.address);
            queuePendingPackets(connection);
            return;
        }
        byte[] frame = connection.frames[connection.frameIndex];
        connection.characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        connection.characteristic.setValue(frame);
        try {
            if (connection.gatt.writeCharacteristic(connection.characteristic)) {
                // The next frame is sent only after onCharacteristicWrite confirms this one.
                connection.frameIndex++;
            } else {
                fail("Android rejected a BLE packet frame.");
                disconnect(connection);
            }
        } catch (SecurityException exception) {
            fail("Android denied a BLE packet frame write.");
            disconnect(connection);
        }
    }

    private void disconnect(Connection connection) {
        synchronized (connections) { connections.remove(connection.address); }
        try { connection.gatt.disconnect(); connection.gatt.close(); } catch (Exception ignored) { }
    }

    private void acceptFrame(String address, byte[] frame) {
        if (frame.length <= FRAME_HEADER_BYTES || frame.length > 512
                || (frame[0] & 0xff) != FRAME_MAGIC_0 || (frame[1] & 0xff) != FRAME_MAGIC_1) {
            fail("Rejected an invalid BLE packet frame.");
            return;
        }
        int transferId = ((frame[2] & 0xff) << 8) | (frame[3] & 0xff);
        int index = ((frame[4] & 0xff) << 8) | (frame[5] & 0xff);
        int total = ((frame[6] & 0xff) << 8) | (frame[7] & 0xff);
        if (total < 1 || total > 2048 || index >= total) { fail("Rejected an out-of-range BLE fragment."); return; }
        byte[] payload = Arrays.copyOfRange(frame, FRAME_HEADER_BYTES, frame.length);
        byte[] completed = null;
        synchronized (assemblies) {
            Assembly assembly = assemblies.get(address);
            if (assembly == null || assembly.transferId != transferId || assembly.total != total
                    || System.currentTimeMillis() - assembly.createdAt > 30_000L) {
                assembly = new Assembly(transferId, total);
                assemblies.put(address, assembly);
            }
            if (assembly.chunks[index] == null) {
                assembly.chunks[index] = payload;
                assembly.received++;
                assembly.byteCount += payload.length;
            }
            if (assembly.byteCount > MAX_PACKET_BYTES) { assemblies.remove(address); fail("Rejected an oversized BLE packet."); return; }
            if (assembly.received == assembly.total) {
                ByteArrayOutputStream output = new ByteArrayOutputStream(assembly.byteCount);
                for (byte[] chunk : assembly.chunks) {
                    if (chunk == null) return;
                    output.write(chunk, 0, chunk.length);
                }
                completed = output.toByteArray();
                assemblies.remove(address);
            }
        }
        if (completed == null) return;
        String json = new String(completed, StandardCharsets.UTF_8);
        JSONObject packet = validatePacket(json);
        if (packet == null) { fail("Rejected an invalid, expired, or unencrypted BLE packet."); return; }
        String recipient = packet.optString("recipient_id");
        boolean isRecipient = !localUserId.isEmpty() && localUserId.equals(recipient);
        if (!isRecipient && (!relayEnabled || packet.optInt("route_hops", 0) >= BlePacketStore.MAX_RELAY_HOPS)) return;
        if (packetStore == null || !packetStore.putPacket(packet, false, address)) {
            fail("The bounded encrypted nearby queue is full; this packet was dropped.");
            return;
        }
        if (!isRecipient && relayEnabled) handler.post(this::queuePendingForAllConnections);
    }

    public static String drainInboundPackets() {
        JSONArray packets = new JSONArray();
        BleMeshService service = instance;
        if (service == null || service.packetStore == null || localUserId.isEmpty()) return packets.toString();
        for (String json : service.packetStore.leaseRecipientPackets(localUserId, 20)) {
            try { packets.put(new JSONObject(json)); }
            catch (Exception ignored) { }
        }
        return packets.toString();
    }

    private int getConnectedPeerCount() {
        synchronized (connections) { return connections.size(); }
    }

    private boolean hasBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void fail(String message) {
        error = message == null ? "BLE packet transport failed." : message;
        Log.w(TAG, error);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Nearby device discovery", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown only while you have explicitly enabled nearby discovery.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification makeNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("ProxiTalk nearby service is on")
                .setContentText(relayEnabled ? "Opt-in encrypted packet relay is active (3-hop cap)." : "Nearby send/receive is active; packet relay is off.")
                .setOngoing(true)
                .build();
    }

    public static String snapshotJson() {
        JSONObject result = new JSONObject();
        JSONArray peers = new JSONArray();
        synchronized (PEERS) {
            long cutoff = System.currentTimeMillis() - PEER_TIMEOUT_MS;
            PEERS.entrySet().removeIf(entry -> entry.getValue() < cutoff);
            for (int i = 0; i < PEERS.size(); i++) peers.put("Nearby ProxiTalk device");
        }
        int serverCount;
        synchronized (SERVER_PEERS) { serverCount = SERVER_PEERS.size(); }
        BleMeshService service = instance;
        int clientCount = service == null ? 0 : service.getConnectedPeerCount();
        try {
            result.put("available", true);
            result.put("running", running);
            result.put("scanning", running && scanning);
            result.put("advertising", running && advertising);
            result.put("peerCount", peers.length());
            result.put("connectedPeerCount", Math.max(serverCount, clientCount));
            result.put("peers", peers);
            result.put("transport", "durable-bounded-gatt-relay");
            result.put("relayEnabled", relayEnabled);
            result.put("queuedPacketCount", service == null || service.packetStore == null ? 0 : service.packetStore.pendingCount());
            result.put("maxRelayHops", BlePacketStore.MAX_RELAY_HOPS);
            result.put("error", error);
            return result.toString();
        } catch (Exception ignored) { return "{}"; }
    }

    @Override public void onDestroy() {
        running = false;
        handler.removeCallbacks(expirePeers);
        try { if (scanner != null && scanCallback != null && scanningInstance) scanner.stopScan(scanCallback); }
        catch (SecurityException ignored) { }
        try { if (advertiser != null && advertiseCallback != null && advertisingInstance) advertiser.stopAdvertising(advertiseCallback); }
        catch (SecurityException ignored) { }
        synchronized (connections) {
            for (Connection connection : connections.values()) {
                try { connection.gatt.disconnect(); connection.gatt.close(); } catch (Exception ignored) { }
            }
            connections.clear();
            connecting.clear();
        }
        try { if (gattServer != null) gattServer.close(); } catch (SecurityException ignored) { }
        gattServer = null;
        scanningInstance = false;
        advertisingInstance = false;
        scanning = false;
        advertising = false;
        synchronized (PEERS) { PEERS.clear(); }
        synchronized (SERVER_PEERS) { SERVER_PEERS.clear(); }
        synchronized (assemblies) { assemblies.clear(); }
        if (packetStore != null) { packetStore.close(); packetStore = null; }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
