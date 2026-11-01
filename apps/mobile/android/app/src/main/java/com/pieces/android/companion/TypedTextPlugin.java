package com.pieces.android.companion;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Cipher;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Capacitor bridge for typed-text summaries and audit screen (A5-1 Section 4.9 & Section 8).
 * Never returns raw input text. Unlocks encrypted notes per epoch with BiometricPrompt.
 */
@CapacitorPlugin(name = "TypedText")
public class TypedTextPlugin extends Plugin {
    private static final String PREFS_NAME = "typed_text_prefs";
    private static final String KEY_PREFERRED_CONTROL = "preferred_control";

    // Unlocked KEKs cached in RAM for the lifetime of the audit session; zero-filled on lock/deleteAll
    private static final Map<Long, byte[]> sUnlockedEpochKeks = new ConcurrentHashMap<>();
    private static volatile int sAuditSessionGeneration = 0;
    private SummaryStore store;

    static synchronized void lockAuditSession() {
        sAuditSessionGeneration++;
        for (byte[] kek : sUnlockedEpochKeks.values()) {
            if (kek != null) {
                Arrays.fill(kek, (byte) 0);
            }
        }
        sUnlockedEpochKeks.clear();
    }

    @Override
    public void load() {
        super.load();
        store = SummaryStore.getInstance(getContext());
        TypedTextCounters.init(getContext());
        TypedTextGate.init(getContext());
        TypedTextSummaryQueue.getInstance().init(getContext(), null, store);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        lockAuditSession();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        lockAuditSession();
    }

    @PluginMethod
    public void lockAuditSession(PluginCall call) {
        lockAuditSession();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void setSecureWindow(PluginCall call) {
        boolean secure = call.getBoolean("secure", true);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    if (secure) {
                        getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
                    } else {
                        getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Failed to set window flags", e);
                }
            });
        } else {
            call.reject("Activity not available");
        }
    }

    @PluginMethod
    public void getCounters(PluginCall call) {
        try {
            JSObject ret = JSObject.fromJSONObject(TypedTextCounters.getCountersJson());
            call.resolve(ret);
        } catch (Exception e) {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void isGateOn(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("on", TypedTextGate.isOn());
        call.resolve(ret);
    }

    @PluginMethod
    public void toggleGate(PluginCall call) {
        Boolean enable = call.getBoolean("enabled");
        if (enable == null) {
            enable = !TypedTextGate.isOn();
        }
        if (enable) {
            TypedTextGate.turnOn(getContext());
        } else {
            TypedTextGate.turnOff(getContext());
        }
        JSObject ret = new JSObject();
        ret.put("on", TypedTextGate.isOn());
        call.resolve(ret);
    }

    @PluginMethod
    public void setPreferredControl(PluginCall call) {
        String control = call.getString("control", "app");
        if ("accessibility_button".equals(control) || "button".equals(control)) {
            control = "accessibility_button";
        } else if ("quick_settings_tile".equals(control) || "tile".equals(control)) {
            control = "quick_settings_tile";
        } else if ("in_app".equals(control) || "app".equals(control)) {
            control = "in_app";
        } else {
            call.reject("Invalid control: must be button/accessibility_button, tile/quick_settings_tile, or app/in_app", "INVALID_ARGUMENT");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_PREFERRED_CONTROL, control).apply();
        JSObject ret = new JSObject();
        ret.put("control", control);
        call.resolve(ret);
    }

    @PluginMethod
    public void getPreferredControl(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String control = prefs.getString(KEY_PREFERRED_CONTROL, "accessibility_button");
        JSObject ret = new JSObject();
        ret.put("control", control);
        call.resolve(ret);
    }

    @PluginMethod
    public void listNotes(PluginCall call) {
        if (store == null) store = new SummaryStore(getContext());
        List<SummaryStore.NoteRecord> records = store.listNoteRecords();

        JSArray notesArray = new JSArray();
        for (SummaryStore.NoteRecord r : records) {
            JSObject noteJson = new JSObject();
            noteJson.put("id", r.id);
            noteJson.put("epoch_id", r.epochId);
            noteJson.put("created_at", r.createdAt);
            noteJson.put("expires_at", r.expiresAt);
            noteJson.put("app_category", r.appCategory);
            noteJson.put("source", r.source);

            byte[] kek = sUnlockedEpochKeks.get(r.epochId);
            if (kek != null) {
                JSONObject decrypted = SummaryStore.decryptNote(r, kek);
                if (decrypted != null) {
                    noteJson.put("unlocked", true);
                    noteJson.put("intent", decrypted.optString("intent", ""));
                    noteJson.put("topics", decrypted.optJSONArray("topics"));
                    noteJson.put("entity_types", decrypted.optJSONArray("entity_types"));
                    noteJson.put("summary", decrypted.optString("summary", ""));
                    noteJson.put("stripped_reason", decrypted.optString("stripped_reason", null));
                } else {
                    noteJson.put("unlocked", false);
                }
            } else {
                noteJson.put("unlocked", false);
            }
            notesArray.put(noteJson);
        }

        JSObject ret = new JSObject();
        ret.put("notes", notesArray);
        call.resolve(ret);
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        Long epochId = call.getLong("epoch");
        if (epochId == null) {
            call.reject("Missing epoch ID", "INVALID_ARGUMENT");
            return;
        }

        if (!(getActivity() instanceof FragmentActivity)) {
            call.reject("No activity available for biometrics", "NO_ACTIVITY");
            return;
        }
        final FragmentActivity activity = (FragmentActivity) getActivity();

        Cipher cipher;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            PrivateKey privateKey = (PrivateKey) ks.getKey(SummaryStore.KEY_ALIAS, null);
            if (privateKey == null) {
                call.reject("No summary decryption key found in KeyStore", "NO_KEY");
                return;
            }
            cipher = SummaryStore.getRsaOaepCipher();
            cipher.init(Cipher.DECRYPT_MODE, privateKey, SummaryStore.getOaepParameterSpec());
        } catch (Exception e) {
            call.reject("Failed to initialize biometric cipher: " + e.getMessage(), "KEY_ERROR");
            return;
        }

        final int sessionGen = sAuditSessionGeneration;

        activity.runOnUiThread(() -> {
            BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        if (sessionGen != sAuditSessionGeneration) {
                            call.reject("Audit session was locked", "LOCKED");
                            return;
                        }

                        Cipher authenticatedCipher = result.getCryptoObject() != null ? result.getCryptoObject().getCipher() : null;
                        if (authenticatedCipher == null) {
                            call.reject("No authenticated cipher returned", "AUTH_ERROR");
                            return;
                        }

                        // Retrieve wrapped_kek for this epoch
                        byte[] wrappedKek = getWrappedKekForEpoch(epochId);
                        if (wrappedKek == null) {
                            call.reject("Epoch not found or missing wrapped KEK", "NOT_FOUND");
                            return;
                        }

                        byte[] unwrappedKek = authenticatedCipher.doFinal(wrappedKek);
                        if (sessionGen != sAuditSessionGeneration) {
                            Arrays.fill(unwrappedKek, (byte) 0);
                            call.reject("Audit session was locked", "LOCKED");
                            return;
                        }

                        sUnlockedEpochKeks.put(epochId, unwrappedKek);

                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        ret.put("epoch_id", epochId);
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("Decryption failed: " + e.getMessage(), "DECRYPT_ERROR");
                    }
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    boolean cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED
                        || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                        || errorCode == BiometricPrompt.ERROR_CANCELED;
                    call.reject(errString.toString(), cancelled ? "CANCELLED" : "AUTH_ERROR");
                }
            };

            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Typed Summaries")
                .setSubtitle("Authenticate to decrypt summaries for this epoch")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .setConfirmationRequired(true)
                .build();

            new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), callback)
                .authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private byte[] getWrappedKekForEpoch(long epochId) {
        if (store == null) store = new SummaryStore(getContext());
        try {
            android.database.sqlite.SQLiteDatabase db = getContext().openOrCreateDatabase(
                SummaryStore.DB_NAME, Context.MODE_PRIVATE, null
            );
            try (android.database.Cursor c = db.rawQuery("SELECT wrapped_kek FROM epoch WHERE id = ?", new String[]{String.valueOf(epochId)})) {
                if (c.moveToFirst()) {
                    return c.getBlob(0);
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    @PluginMethod
    public void deleteNote(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("Missing note ID", "INVALID_ARGUMENT");
            return;
        }
        try {
            android.database.sqlite.SQLiteDatabase db = getContext().openOrCreateDatabase(
                SummaryStore.DB_NAME, Context.MODE_PRIVATE, null
            );
            db.delete("note", "id = ?", new String[]{id});
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Delete failed: " + e.getMessage(), "DB_ERROR");
        }
    }

    @PluginMethod
    public void deleteAll(PluginCall call) {
        synchronized (TypedTextGate.COMMIT_LOCK) {
            TypedTextSummaryQueue.clear();
            lockAuditSession();
            if (store == null) store = SummaryStore.getInstance(getContext());
            store.deleteAll();
        }

        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
