package com.pieces.android.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "Pairing")
public class PairingPlugin extends Plugin {

    @PluginMethod
    public void parsePairingPayload(PluginCall call) {
        String raw = call.getString("raw");
        if (raw == null || raw.trim().isEmpty()) {
            call.reject("Missing raw QR payload string");
            return;
        }

        try {
            JSONObject json = new JSONObject(raw);
            String baseUrl = json.optString("baseUrl", "");
            if (baseUrl.isEmpty()) {
                String ip = json.optString("ip", json.optString("tailscaleIp", ""));
                int port = json.optInt("port", 8788);
                if (!ip.isEmpty()) {
                    baseUrl = "http://" + ip + ":" + port;
                }
            }

            String token = json.optString("token", "");
            String pairingToken = json.optString("pairingToken", "");

            boolean isPairing = !pairingToken.isEmpty() || token.startsWith("pt_");
            if (pairingToken.isEmpty() && token.startsWith("pt_")) {
                pairingToken = token;
                token = "";
            }

            JSObject ret = new JSObject();
            ret.put("baseUrl", baseUrl.replaceAll("/+$", ""));
            ret.put("token", token);
            ret.put("pairingToken", pairingToken);
            ret.put("isPairingToken", isPairing);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Invalid QR JSON payload: " + e.getMessage());
        }
    }
}
