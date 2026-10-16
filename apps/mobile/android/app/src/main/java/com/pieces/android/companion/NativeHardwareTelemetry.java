package com.pieces.android.companion;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import org.json.JSONObject;

/**
 * Collects native on-device hardware telemetry:
 * 1. Audio mode & routing (in_call, in_communication, music active, bluetooth/headphone routing).
 * 2. Thermal headroom (ThermalManager proactive throttling forecasting).
 * 3. Battery micro-telemetry (current mA, battery temp °C, voltage mV, charging type).
 * 4. Motion state (Context Hub / hardware sensor physical activity inference).
 *
 * Runs offline with zero network requests and minimal battery footprint.
 */
public final class NativeHardwareTelemetry {

    private static volatile String lastMotionState = "unknown";
    private static volatile float lastMotionConfidence = 0.0f;

    private static final long CACHE_TTL_MS = 5000;
    private static volatile long lastCollectElapsedMs = 0;
    private static volatile JSONObject cachedSnapshot = null;

    private NativeHardwareTelemetry() {}

    /**
     * Updates the cached motion classification state (e.g. from sensors or activity callbacks).
     */
    public static void updateMotionState(String state, float confidence) {
        if (state != null && !state.isEmpty()) {
            lastMotionState = state;
            lastMotionConfidence = Math.max(0.0f, Math.min(1.0f, confidence));
        }
    }

    /**
     * Collects all native hardware telemetry into a structured JSON snapshot.
     * Uses a 5-second cache to avoid excessive Binder IPC and registerReceiver calls.
     */
    public static JSONObject collect(Context context) {
        if (context == null) return new JSONObject();

        long now = android.os.SystemClock.elapsedRealtime();
        synchronized (NativeHardwareTelemetry.class) {
            JSONObject cached = cachedSnapshot;
            if (cached != null && (now - lastCollectElapsedMs < CACHE_TTL_MS)) {
                try {
                    return new JSONObject(cached.toString());
                } catch (Throwable ignored) {
                    return cached;
                }
            }
        }

        JSONObject root = new JSONObject();
        try {
            // 1. Audio Telemetry
            JSONObject audio = collectAudio(context);
            if (audio != null) root.put("audio", audio);

            // 2. Thermal Telemetry
            JSONObject thermal = collectThermal(context);
            if (thermal != null) root.put("thermal", thermal);

            // 3. Battery Micro-Telemetry
            JSONObject battery = collectBattery(context);
            if (battery != null) root.put("battery_micro", battery);

            // 4. Motion Telemetry
            JSONObject motion = collectMotion(context);
            if (motion != null) root.put("motion", motion);

            root.put("sampled_at_elapsed_ms", now);

            synchronized (NativeHardwareTelemetry.class) {
                cachedSnapshot = root;
                lastCollectElapsedMs = now;
            }
        } catch (Throwable ignored) {}

        try {
            return new JSONObject(root.toString());
        } catch (Throwable ignored) {
            return root;
        }
    }

    public static JSONObject collectAudio(Context context) {
        try {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return null;

            JSONObject obj = new JSONObject();
            int mode = am.getMode();
            String modeStr;
            boolean inCall = false;

            switch (mode) {
                case AudioManager.MODE_IN_CALL:
                    modeStr = "in_call";
                    inCall = true;
                    break;
                case AudioManager.MODE_IN_COMMUNICATION:
                    modeStr = "in_communication"; // VoIP (Zoom, Meet, Teams, WhatsApp)
                    inCall = true;
                    break;
                case AudioManager.MODE_RINGTONE:
                    modeStr = "ringtone";
                    break;
                default:
                    modeStr = "normal";
                    break;
            }

            obj.put("mode", modeStr);
            obj.put("in_call", inCall);
            obj.put("music_active", am.isMusicActive());

            // Detect audio output routing
            String outputType = "speaker";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                if (devices != null) {
                    for (AudioDeviceInfo dev : devices) {
                        int type = dev.getType();
                        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                                || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET)
                                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && type == AudioDeviceInfo.TYPE_HEARING_AID)) {
                            outputType = "bluetooth_headset";
                            break;
                        } else if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                                || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                                || type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                            outputType = "wired_headset";
                        }
                    }
                }
            } else {
                if (am.isBluetoothA2dpOn() || am.isBluetoothScoOn()) {
                    outputType = "bluetooth_headset";
                } else if (am.isWiredHeadsetOn()) {
                    outputType = "wired_headset";
                }
            }
            // On Android 12+ (API 31+), check explicit active communication device only during an active call/meeting
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION)) {
                AudioDeviceInfo commDevice = am.getCommunicationDevice();
                if (commDevice != null) {
                    int type = commDevice.getType();
                    if (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
                        outputType = "bluetooth_headset";
                    } else if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                        outputType = "wired_headset";
                    } else if (type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                        outputType = "earpiece";
                    } else if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        outputType = "speaker";
                    }
                }
            }
            obj.put("output_type", outputType);

            return obj;
        } catch (Throwable t) {
            return null;
        }
    }

    public static JSONObject collectThermal(Context context) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return null;

            float headroom = pm.getThermalHeadroom(0);
            if (Float.isNaN(headroom) || headroom < 0) return null;

            JSONObject obj = new JSONObject();
            obj.put("headroom", (double) headroom);
            if (headroom >= 1.0f) {
                obj.put("status", "throttling");
            } else if (headroom >= 0.7f) {
                obj.put("status", "elevated");
            } else {
                obj.put("status", "nominal");
            }
            return obj;
        } catch (Throwable t) {
            return null;
        }
    }

    public static JSONObject collectBattery(Context context) {
        try {
            Intent intent = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return null;

            JSONObject obj = new JSONObject();

            // Battery temperature in tenths of degree C
            int tempTenths = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
            if (tempTenths > 0) {
                obj.put("temp_c", tempTenths / 10.0);
            }

            // Battery voltage in mV
            int voltageMv = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1);
            if (voltageMv > 0) {
                obj.put("voltage_mv", voltageMv);
            }

            // Charging type
            int plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1);
            String pluggedStr = "unplugged";
            if (plugged == BatteryManager.BATTERY_PLUGGED_AC) pluggedStr = "ac";
            else if (plugged == BatteryManager.BATTERY_PLUGGED_USB) pluggedStr = "usb";
            else if (plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS) pluggedStr = "wireless";
            obj.put("plugged", pluggedStr);

            // Instantaneous current (in mA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
                if (bm != null) {
                    int currentMicroAmps = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
                    if (currentMicroAmps != Integer.MIN_VALUE && currentMicroAmps != 0) {
                        obj.put("current_ma", (double) currentMicroAmps / 1000.0);
                    }
                }
            }

            return obj;
        } catch (Throwable t) {
            return null;
        }
    }

    public static JSONObject collectMotion(Context context) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("state", lastMotionState);
            obj.put("confidence", (double) lastMotionConfidence);
            return obj;
        } catch (Throwable t) {
            return null;
        }
    }
}
