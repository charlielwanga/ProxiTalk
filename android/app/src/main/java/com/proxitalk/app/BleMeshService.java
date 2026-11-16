package com.proxitalk.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Opt-in Android BLE discovery foundation. It does not exchange or relay message packets. */
public final class BleMeshService extends Service {
    public static final UUID SERVICE_UUID = UUID.fromString("7dd9a5d0-62a5-4a17-9e16-5f50b331a101");
    private static final String TAG = "ProxiTalkBLE";
    private static final String CHANNEL_ID = "proxitalk_nearby";
    private static final int NOTIFICATION_ID = 4107;
    private static final long PEER_TIMEOUT_MS = 30_000L;
    private static final Map<String, Long> PEERS = new HashMap<>();
    private static volatile boolean running = false;
    private static volatile String error = "";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private ScanCallback scanCallback;
    private AdvertiseCallback advertiseCallback;
    private static volatile boolean scanning;
    private static volatile boolean advertising;

    private final Runnable expirePeers = new Runnable() {
        @Override public void run() {
            synchronized (PEERS) {
                long cutoff = System.currentTimeMillis() - PEER_TIMEOUT_MS;
                PEERS.entrySet().removeIf(entry -> entry.getValue() < cutoff);
            }
            if (running) handler.postDelayed(this, 5_000L);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
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
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
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
            startAdvertising();
            startScanning();
            running = true;
            error = "";
            handler.removeCallbacks(expirePeers);
            handler.postDelayed(expirePeers, 5_000L);
        } catch (SecurityException exception) {
            fail("Android denied Bluetooth access: " + exception.getMessage());
            stopSelf();
        }
    }

    private void startAdvertising() {
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW)
                .setConnectable(false)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                advertising = true;
                error = "";
            }
            @Override public void onStartFailure(int errorCode) {
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
                    String address = result.getDevice().getAddress();
                    if (address != null) {
                        synchronized (PEERS) { PEERS.put(address, System.currentTimeMillis()); }
                    }
                } catch (SecurityException exception) {
                    fail("Android denied access to nearby-device details.");
                }
            }
            @Override public void onScanFailed(int errorCode) {
                scanning = false;
                fail("BLE scan failed (" + errorCode + ").");
            }
        };
        scanner.startScan(filters, settings, scanCallback);
        scanning = true;
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
        error = message == null ? "BLE discovery failed." : message;
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
                .setContentTitle("ProxiTalk nearby discovery is on")
                .setContentText("Discovery only — messages are not being relayed yet.")
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
        try {
            result.put("available", true);
            result.put("running", running);
            result.put("scanning", running && scanning);
            result.put("advertising", running && advertising);
            result.put("peerCount", peers.length());
            result.put("peers", peers);
            result.put("transport", "discovery-only");
            result.put("error", error);
            return result.toString();
        } catch (Exception ignored) { return "{}"; }
    }

    @Override public void onDestroy() {
        running = false;
        handler.removeCallbacks(expirePeers);
        try { if (scanner != null && scanCallback != null) scanner.stopScan(scanCallback); }
        catch (SecurityException ignored) { }
        try { if (advertiser != null && advertiseCallback != null) advertiser.stopAdvertising(advertiseCallback); }
        catch (SecurityException ignored) { }
        scanning = false;
        advertising = false;
        synchronized (PEERS) { PEERS.clear(); }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
