package com.pieces.android.companion;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AccessibilityPlugin.class);
        registerPlugin(OnDeviceTriagePlugin.class);
        registerPlugin(TextEmbedderPlugin.class);
        registerPlugin(NotificationPlugin.class);
        registerPlugin(SmsPlugin.class);
        registerPlugin(ApprovalKeyPlugin.class);
        registerPlugin(DevicePermissionsPlugin.class);
        registerPlugin(SecureCredentialsPlugin.class);
        registerPlugin(PairingPlugin.class);
        registerPlugin(SensorConsentPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        UsageSummary.queueArrivalsIfDue(this); // no-op unless app_switches consent is on
    }
}
