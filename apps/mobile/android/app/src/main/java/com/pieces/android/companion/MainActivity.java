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
        super.onCreate(savedInstanceState);
    }
}
