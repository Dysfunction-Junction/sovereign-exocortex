package com.pieces.android.companion;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS name "PlaceLabel". Where you are now, naming a learned place, and forgetting them all.
 *   current()                 -> { placeId|null, label, dwellMs }   (ids are random, never an SSID)
 *   setLabel({placeId,label}) -> label: home | work | other | unlabeled
 *   forget()                  -> erases the place model and the hashing key, and unsent place events
 */
@CapacitorPlugin(name = "PlaceLabel")
public class PlaceLabelPlugin extends Plugin {
    @PluginMethod
    public void current(PluginCall call) {
        PlaceModel m = new PlaceSampler.PrefsStore(getContext()).load();
        String id = m.currentPlaceId();
        JSObject out = new JSObject();
        PlaceModel.Place p = id == null ? null : m.places.get(id);
        out.put("placeId", p == null ? null : p.id);
        out.put("label", p == null ? "unknown" : p.label);
        out.put("dwellMs", p == null ? 0L : Math.max(0L, System.currentTimeMillis() - m.currentArrivedAt()));
        call.resolve(out);
    }

    @PluginMethod
    public void setLabel(PluginCall call) {
        final String placeId = call.getString("placeId");
        final String label = call.getString("label");
        if (placeId == null || !PlaceModel.isLabel(label)) {
            call.reject("placeId and a label of home, work, other or unlabeled are required");
            return;
        }
        boolean ok = new PlaceSampler.PrefsStore(getContext()).update(m -> m.setLabel(placeId, label));
        if (!ok) {
            call.reject("unknown place");
            return;
        }
        current(call);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        new PlaceSampler.PrefsStore(getContext()).forget();
        NativeTelemetrySync.purgeUnsentV3(getContext(), "pw-", null);
        NativeTelemetrySync.purgeUnsentV3(getContext(), "pe-", null);
        call.resolve();
    }
}
