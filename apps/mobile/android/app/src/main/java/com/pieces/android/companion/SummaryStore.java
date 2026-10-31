package com.pieces.android.companion;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Encrypted SQLite store for typed text and speech summaries (A5-1 Section 4.8 & Section 8).
 * AES-256-GCM note encryption under daily KEK wrapped with Biometric RSA-OAEP public key.
 */
class SummaryStore {
    static final String DB_NAME = "typed_summaries.db";
    static final int DB_VERSION = 1;
    static final String KEY_ALIAS = "exocortex_typed_summary_v1";
    static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    static final long RETENTION_MS = 7L * 24 * 60 * 60 * 1000; // 7 days
    static final long KEK_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    static final long MAX_EPOCH_DURATION_MS = 24L * 60 * 60 * 1000; // 24 hours max epoch duration

    private static final ScheduledExecutorService sScheduler = Executors.newSingleThreadScheduledExecutor();
    private static SummaryStore sInstance;

    static synchronized SummaryStore getInstance(Context ctx) {
        if (sInstance == null) {
            sInstance = new SummaryStore(ctx != null ? ctx.getApplicationContext() : null);
        }
        return sInstance;
    }

    static synchronized void setInstanceForTesting(SummaryStore store) {
        sInstance = store;
    }

    static synchronized void zeroFillActiveKek() {
        if (sInstance != null) {
            sInstance.zeroFillKek();
        }
    }

    interface KeyProvider {
        PublicKey getPublicKey() throws Exception;
        Cipher initDecryptCipher(PrivateKey key) throws Exception;
    }

    private final SQLiteOpenHelper dbHelper;
    private final SecureRandom random = new SecureRandom();
    private final KeyProvider keyProvider;

    private byte[] currentKek;
    private long currentEpochId = -1;
    private long currentEpochCreatedAtMs = 0;
    private long lastWriteMonotonicMs = 0;
    private ScheduledFuture<?> idleWipeFuture;

    static final class NoteRecord {
        final String id;
        final long epochId;
        final long createdAt;
        final long expiresAt;
        final String appCategory;
        final String source;
        final byte[] iv;
        final byte[] ct;

        NoteRecord(String id, long epochId, long createdAt, long expiresAt, String appCategory, String source, byte[] iv, byte[] ct) {
            this.id = id;
            this.epochId = epochId;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.appCategory = appCategory;
            this.source = source;
            this.iv = iv;
            this.ct = ct;
        }

        JSONObject toMetadataJson() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("id", id);
                obj.put("epoch_id", epochId);
                obj.put("created_at", createdAt);
                obj.put("expires_at", expiresAt);
                obj.put("app_category", appCategory);
                obj.put("source", source);
            } catch (Exception ignored) {}
            return obj;
        }
    }

    SummaryStore(Context context) {
        this(new DefaultOpenHelper(context), new AndroidKeyStoreProvider());
    }

    SummaryStore(SQLiteOpenHelper helper, KeyProvider keyProvider) {
        this.dbHelper = helper;
        this.keyProvider = keyProvider;
    }

    private synchronized void scheduleIdleWipe() {
        if (idleWipeFuture != null) {
            idleWipeFuture.cancel(false);
            idleWipeFuture = null;
        }
        try {
            idleWipeFuture = sScheduler.schedule(this::zeroFillKek, KEK_IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception ignored) {}
    }

    synchronized boolean saveSummary(String appCategory, String source, SummaryGuard.Summary summary) {
        if (summary == null) return false;
        long now = System.currentTimeMillis();
        long nowMonotonic = System.nanoTime() / 1_000_000L;
        try {
            ensureEpoch(now, nowMonotonic);
            if (currentKek == null) return false;

            String id = UUID.randomUUID().toString();
            long expiresAt = now + RETENTION_MS;

            byte[] iv = new byte[12];
            random.nextBytes(iv);

            // AAD = id || created_at
            byte[] aad = (id + now).getBytes(StandardCharsets.UTF_8);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            SecretKeySpec keySpec = new SecretKeySpec(currentKek, "AES");
            GCMParameterSpec gcmSpec = new GCMParameterSpec(128, iv);
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec);
            cipher.updateAAD(aad);

            byte[] plaintext = summary.toJson().toString().getBytes(StandardCharsets.UTF_8);
            byte[] ct = cipher.doFinal(plaintext);

            SQLiteDatabase db = dbHelper.getWritableDatabase();
            ContentValues cv = new ContentValues();
            cv.put("id", id);
            cv.put("epoch_id", currentEpochId);
            cv.put("created_at", now);
            cv.put("expires_at", expiresAt);
            cv.put("app_category", appCategory != null ? appCategory : "other");
            cv.put("source", source != null ? source : "typed");
            cv.put("iv", iv);
            cv.put("ct", ct);

            long row = db.insertWithOnConflict("note", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            if (row != -1) {
                lastWriteMonotonicMs = nowMonotonic;
                scheduleIdleWipe();
                purgeExpired(now);
                return true;
            }
        } catch (Throwable t) {
            // Fail closed; never store plaintext
        }
        return false;
    }

    private synchronized void ensureEpoch(long now, long nowMonotonic) throws Exception {
        if (currentKek != null &&
            (nowMonotonic - lastWriteMonotonicMs <= KEK_IDLE_TIMEOUT_MS) &&
            (now - currentEpochCreatedAtMs < MAX_EPOCH_DURATION_MS)) {
            lastWriteMonotonicMs = nowMonotonic;
            scheduleIdleWipe();
            return;
        }
        zeroFillKek();

        // Generate fresh AES-256 KEK
        byte[] kek = new byte[32];
        random.nextBytes(kek);

        PublicKey pubKey = keyProvider.getPublicKey();
        Cipher rsaCipher = getRsaOaepCipher();
        rsaCipher.init(Cipher.ENCRYPT_MODE, pubKey, getOaepParameterSpec());
        byte[] wrappedKek = rsaCipher.doFinal(kek);

        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("created_at", now);
        cv.put("wrapped_kek", wrappedKek);
        cv.put("iv_free", 0);

        long epochId = db.insert("epoch", null, cv);
        if (epochId == -1) {
            Arrays.fill(kek, (byte) 0);
            throw new IllegalStateException("Failed to insert epoch");
        }

        currentKek = kek;
        currentEpochId = epochId;
        currentEpochCreatedAtMs = now;
        lastWriteMonotonicMs = nowMonotonic;
        scheduleIdleWipe();
    }

    synchronized void zeroFillKek() {
        if (idleWipeFuture != null) {
            idleWipeFuture.cancel(false);
            idleWipeFuture = null;
        }
        if (currentKek != null) {
            Arrays.fill(currentKek, (byte) 0);
            currentKek = null;
        }
        currentEpochId = -1;
        currentEpochCreatedAtMs = 0;
        lastWriteMonotonicMs = 0;
    }

    synchronized void purgeExpired(long now) {
        try {
            SQLiteDatabase db = dbHelper.getWritableDatabase();
            db.delete("note", "expires_at <= ?", new String[]{String.valueOf(now)});
            db.delete("epoch", "id NOT IN (SELECT DISTINCT epoch_id FROM note)", null);
        } catch (Exception ignored) {}
    }

    synchronized void deleteAll() {
        zeroFillKek();
        try {
            SQLiteDatabase db = dbHelper.getWritableDatabase();
            db.delete("note", null, null);
            db.delete("epoch", null, null);
            db.execSQL("VACUUM;");
        } catch (Exception ignored) {}

        try {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) {
                ks.deleteEntry(KEY_ALIAS);
            }
        } catch (Exception ignored) {}
    }

    synchronized List<NoteRecord> listNoteRecords() {
        long now = System.currentTimeMillis();
        purgeExpired(now);
        List<NoteRecord> list = new ArrayList<>();
        try {
            SQLiteDatabase db = dbHelper.getReadableDatabase();
            try (Cursor c = db.rawQuery(
                "SELECT id, epoch_id, created_at, expires_at, app_category, source, iv, ct FROM note WHERE expires_at > ? ORDER BY created_at DESC",
                new String[]{String.valueOf(now)})) {
                while (c.moveToNext()) {
                    list.add(new NoteRecord(
                        c.getString(0),
                        c.getLong(1),
                        c.getLong(2),
                        c.getLong(3),
                        c.getString(4),
                        c.getString(5),
                        c.getBlob(6),
                        c.getBlob(7)
                    ));
                }
            }
        } catch (Exception ignored) {}
        return list;
    }

    static JSONObject decryptNote(NoteRecord note, byte[] kek) {
        if (note == null || kek == null) return null;
        try {
            byte[] aad = (note.id + note.createdAt).getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            SecretKeySpec keySpec = new SecretKeySpec(kek, "AES");
            GCMParameterSpec gcmSpec = new GCMParameterSpec(128, note.iv);
            cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec);
            cipher.updateAAD(aad);
            byte[] plaintext = cipher.doFinal(note.ct);
            return new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    static OAEPParameterSpec getOaepParameterSpec() {
        return new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT);
    }

    static Cipher getRsaOaepCipher() throws Exception {
        return Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
    }

    private static class DefaultOpenHelper extends SQLiteOpenHelper {
        DefaultOpenHelper(Context ctx) {
            super(ctx, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onConfigure(SQLiteDatabase db) {
            super.onConfigure(db);
            db.execSQL("PRAGMA secure_delete = ON;");
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS epoch (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "created_at INTEGER, " +
                "wrapped_kek BLOB, " +
                "iv_free INTEGER);");

            db.execSQL("CREATE TABLE IF NOT EXISTS note (" +
                "id TEXT PRIMARY KEY, " +
                "epoch_id INTEGER, " +
                "created_at INTEGER, " +
                "expires_at INTEGER, " +
                "app_category TEXT, " +
                "source TEXT CHECK(source IN ('typed','speech')), " +
                "iv BLOB, " +
                "ct BLOB);");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}
    }

    private static class AndroidKeyStoreProvider implements KeyProvider {
        @Override
        public PublicKey getPublicKey() throws Exception {
            KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
            ks.load(null);
            if (!ks.containsAlias(KEY_ALIAS)) {
                generateKeyPair();
            }
            return ks.getCertificate(KEY_ALIAS).getPublicKey();
        }

        @Override
        public Cipher initDecryptCipher(PrivateKey key) throws Exception {
            Cipher cipher = getRsaOaepCipher();
            cipher.init(Cipher.DECRYPT_MODE, key, getOaepParameterSpec());
            return cipher;
        }

        private void generateKeyPair() throws Exception {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE);
                KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_DECRYPT
                )
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                .setUserAuthenticationRequired(true);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
                }
                builder.setInvalidatedByBiometricEnrollment(true);
                kpg.initialize(builder.build());
                kpg.generateKeyPair();
            }
        }
    }
}
