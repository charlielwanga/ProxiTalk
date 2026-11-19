package com.proxitalk.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Bounded store for opaque encrypted BLE packets; never stores decrypted message text. */
final class BlePacketStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "proxitalk_ble_store.db";
    private static final int DB_VERSION = 1;
    private static final int MAX_PACKETS = 256;
    private static final long MAX_BYTES = 4L * 1024L * 1024L;
    private static final int MAX_FORWARD_RECORDS = 2_048;
    static final int MAX_RELAY_HOPS = 3;
    private static final long APP_LEASE_MS = 30_000L;

    BlePacketStore(Context context) { super(context, DB_NAME, null, DB_VERSION); }

    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE packets (packet_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, route_hops INTEGER NOT NULL, is_origin INTEGER NOT NULL, recipient_id TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE forwarded (packet_id TEXT NOT NULL, peer_address TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(packet_id, peer_address), FOREIGN KEY(packet_id) REFERENCES packets(packet_id) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX packets_expiry ON packets(expires_at)");
        db.execSQL("CREATE INDEX packets_recipient_lease ON packets(recipient_id, lease_until, expires_at)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    synchronized boolean putPacket(JSONObject packet, boolean origin, String sourceAddress) {
        if (packet == null) return false;
        String id = packet.optString("id", "");
        String recipient = packet.optString("recipient_id", "");
        long created = packet.optLong("created_at", 0L);
        long expires = packet.optLong("expires_at", 0L);
        int routeHops = packet.optInt("route_hops", 0);
        if (id.isEmpty() || recipient.isEmpty() || created <= 0L || expires <= System.currentTimeMillis()
                || routeHops < 0 || routeHops > MAX_RELAY_HOPS) return false;
        String json = packet.toString();
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            prune(db, System.currentTimeMillis());
            boolean exists = false;
            int oldHops = Integer.MAX_VALUE;
            boolean oldOrigin = false;
            try (Cursor cursor = db.rawQuery("SELECT route_hops, is_origin FROM packets WHERE packet_id=?", new String[]{id})) {
                if (cursor.moveToFirst()) { exists = true; oldHops = cursor.getInt(0); oldOrigin = cursor.getInt(1) != 0; }
            }
            if (exists) {
                if (routeHops < oldHops) {
                    ContentValues update = new ContentValues();
                    update.put("envelope", json);
                    update.put("route_hops", routeHops);
                    update.put("is_origin", oldOrigin || origin ? 1 : 0);
                    db.update("packets", update, "packet_id=?", new String[]{id});
                } else if (origin && !oldOrigin) {
                    ContentValues update = new ContentValues(); update.put("is_origin", 1);
                    db.update("packets", update, "packet_id=?", new String[]{id});
                }
            } else {
                try (Cursor cursor = db.rawQuery("SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(envelope AS BLOB))),0) FROM packets", null)) {
                    if (cursor.moveToFirst() && (cursor.getInt(0) >= MAX_PACKETS || cursor.getLong(1) + json.length() > MAX_BYTES)) {
                        db.setTransactionSuccessful();
                        return false;
                    }
                }
                ContentValues values = new ContentValues();
                values.put("packet_id", id); values.put("envelope", json); values.put("created_at", created);
                values.put("expires_at", expires); values.put("route_hops", routeHops); values.put("is_origin", origin ? 1 : 0);
                values.put("recipient_id", recipient); values.put("lease_until", 0L);
                if (db.insertOrThrow("packets", null, values) < 0) return false;
            }
            if (sourceAddress != null && !sourceAddress.isEmpty()) markForwarded(db, id, sourceAddress);
            db.setTransactionSuccessful();
            return true;
        } catch (SQLiteException exception) {
            return false;
        } finally { db.endTransaction(); }
    }

    synchronized List<String> pendingForPeer(String peerAddress, boolean relayEnabled, String localUserId, int limit) {
        List<String> result = new ArrayList<>();
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor cursor = db.rawQuery(
                "SELECT p.packet_id,p.envelope,p.route_hops,p.is_origin,p.recipient_id FROM packets p " +
                "WHERE p.expires_at>? AND NOT EXISTS (SELECT 1 FROM forwarded f WHERE f.packet_id=p.packet_id AND f.peer_address=?) " +
                "AND (p.is_origin=1 OR (CAST(? AS INTEGER)=1 AND p.route_hops<? AND p.recipient_id<>?)) " +
                "ORDER BY p.is_origin DESC,p.created_at ASC LIMIT ?",
                new String[]{String.valueOf(now), peerAddress, relayEnabled ? "1" : "0", String.valueOf(MAX_RELAY_HOPS),
                        localUserId == null ? "" : localUserId, String.valueOf(Math.max(1, limit * 4))})) {
            while (cursor.moveToNext() && result.size() < limit) {
                int hops = cursor.getInt(2);
                boolean origin = cursor.getInt(3) != 0;
                String recipient = cursor.getString(4);
                if (!origin && (!relayEnabled || hops >= MAX_RELAY_HOPS || recipient.equals(localUserId))) continue;
                try {
                    JSONObject packet = new JSONObject(cursor.getString(1));
                    packet.put("route_hops", origin ? hops : hops + 1);
                    result.add(packet.toString());
                } catch (Exception ignored) { }
            }
        } catch (SQLiteException ignored) { }
        return result;
    }

    synchronized List<String> leaseRecipientPackets(String recipientId, int limit) {
        List<String> result = new ArrayList<>();
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            prune(db, now);
            try (Cursor cursor = db.rawQuery("SELECT packet_id,envelope FROM packets WHERE recipient_id=? AND expires_at>? AND lease_until<=? ORDER BY created_at ASC LIMIT ?",
                    new String[]{recipientId, String.valueOf(now), String.valueOf(now), String.valueOf(Math.max(1, limit))})) {
                while (cursor.moveToNext()) {
                    result.add(cursor.getString(1));
                    ContentValues lease = new ContentValues(); lease.put("lease_until", now + APP_LEASE_MS);
                    db.update("packets", lease, "packet_id=?", new String[]{cursor.getString(0)});
                }
            }
            db.setTransactionSuccessful();
        } catch (SQLiteException ignored) { }
        finally { db.endTransaction(); }
        return result;
    }

    synchronized void completePacket(String id) {
        if (id == null || id.isEmpty()) return;
        try { getWritableDatabase().delete("packets", "packet_id=?", new String[]{id}); }
        catch (SQLiteException ignored) { }
    }

    synchronized void markForwarded(String id, String peerAddress) {
        if (id == null || id.isEmpty() || peerAddress == null || peerAddress.isEmpty()) return;
        try { markForwarded(getWritableDatabase(), id, peerAddress); }
        catch (SQLiteException ignored) { }
    }

    synchronized boolean isOrigin(String id) {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT is_origin FROM packets WHERE packet_id=?", new String[]{id})) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        } catch (SQLiteException ignored) { return false; }
    }

    synchronized int pendingCount() {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM packets WHERE expires_at>?", new String[]{String.valueOf(System.currentTimeMillis())})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        } catch (SQLiteException ignored) { return 0; }
    }

    synchronized void prune() {
        try { prune(getWritableDatabase(), System.currentTimeMillis()); }
        catch (SQLiteException ignored) { }
    }

    private static void markForwarded(SQLiteDatabase db, String id, String address) {
        ContentValues values = new ContentValues(); values.put("packet_id", id); values.put("peer_address", address); values.put("sent_at", System.currentTimeMillis());
        db.insertWithOnConflict("forwarded", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM forwarded", null)) {
            if (cursor.moveToFirst() && cursor.getInt(0) > MAX_FORWARD_RECORDS) {
                db.execSQL("DELETE FROM forwarded WHERE rowid IN (SELECT rowid FROM forwarded ORDER BY sent_at ASC, rowid ASC LIMIT ?)",
                        new Object[]{MAX_FORWARD_RECORDS / 4});
            }
        }
    }

    private static void prune(SQLiteDatabase db, long now) {
        db.delete("packets", "expires_at<=?", new String[]{String.valueOf(now)});
    }
}
