package com.pieces.android.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS bridge for {@link SecureCredentialStore}: Keystore-backed storage for the two bearer tokens. */
@CapacitorPlugin(name = "SecureCredentials")
public class SecureCredentialsPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        JSObject ret = new JSObject();
        // null when absent or unreadable (tampered / key invalidated): the caller sees "no token".
        ret.put("value", SecureCredentialStore.get(getContext(), key));
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty() || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            SecureCredentialStore.set(getContext(), key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject("secure credential write failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("key is required");
            return;
        }
        SecureCredentialStore.remove(getContext(), key);
        call.resolve();
    }
}
