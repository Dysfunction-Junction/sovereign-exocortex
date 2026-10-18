package com.pieces.android.companion;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import java.util.Locale;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Collects native on-device hardware telemetry:
 * 1. Audio mode & routing (in_call, in_communication, music active, bluetooth/headphone routing).
 * 2. Thermal headroom (ThermalManager proactive throttling forecasting).
 * 3. Battery micro-telemetry (current mA, battery temp °C, voltage mV, charging type).
 * 4. Motion state (Context Hub / hardware sensor physical activity inference).
 * 5. Physical surface / pocket detection (proximity, ambient lux, gravity Z-axis orientation).
 * 6. Network quality & metered gating (WiFi, cellular, ethernet, VPN, bandwidth kbps, unmetered status).
 *
 * Runs offline with zero network requests and minimal battery footprint.
 */
public final class NativeHardwareTelemetry {

    private static final Pattern CAR_AUDIO_NAME_PATTERN = Pattern.compile(
        "\\b(android\\s*auto|apple\\s*carplay|carplay|uconnect|carkit|car\\s*kit|sync\\s*3|infotainment|audiomms|mycar)\\b",
        Pattern.CASE_INSENSITIVE
    );

    private static volatile String lastMotionState = "unknown";
    private static volatile float lastMotionConfidence = 0.0f;

    private static final class SensorReading {
        final float value;
        final long elapsedNanos;
        SensorReading(float value, long elapsedNanos) {
            this.value = value;
            this.elapsedNanos = elapsedNanos;
        }
    }

    private static volatile boolean sensorsActive = false;
    private static volatile SensorReading lastProximity = null;
    private static volatile float maxProximityRange = 5.0f;
    private static volatile SensorReading lastLight = null;
    private static volatile SensorReading lastGravity = null;
    private static SensorManager globalSensorManager = null;
    private static android.os.HandlerThread sensorThread = null;
    private static android.os.Handler sensorHandler = null;

    private static final long SENSOR_STALE_NANOS = 30_000_000_000L; // 30 seconds for continuous sensors

    private static final SensorEventListener sensorListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (!sensorsActive || event == null || event.values == null || event.values.length == 0) return;
            int type = event.sensor.getType();
            long ts = event.timestamp;
            long eventNanos = (ts > 0) ? ts : SystemClock.elapsedRealtimeNanos();
            if (type == Sensor.TYPE_PROXIMITY) {
                lastProximity = new SensorReading(event.values[0], eventNanos);
            } else if (type == Sensor.TYPE_LIGHT) {
                lastLight = new SensorReading(event.values[0], eventNanos);
            } else if (type == Sensor.TYPE_GRAVITY || type == Sensor.TYPE_ACCELEROMETER) {
                if (event.values.length >= 3) {
                    lastGravity = new SensorReading(event.values[2], eventNanos);
                }
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };

    private static final long CACHE_TTL_MS = 5000;
    private static volatile long lastCollectElapsedMs = 0;
    private static volatile JSONObject cachedSnapshot = null;

    private NativeHardwareTelemetry() {}

    /**
     * Initializes hardware sensors for physical surface & pocket detection.
     * Uses 1s batched sampling with 10s max latency on a dedicated background HandlerThread.
     */
    public static synchronized void initSensors(Context context) {
        if (sensorsActive || context == null) return;
        try {
            Context appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
            SensorManager sm = (SensorManager) appContext.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return;
            globalSensorManager = sm;

            if (sensorThread == null) {
                sensorThread = new android.os.HandlerThread("hw-telemetry-sensors");
                sensorThread.start();
                sensorHandler = new android.os.Handler(sensorThread.getLooper());
            }

            boolean registeredAny = false;

            Sensor prox = sm.getDefaultSensor(Sensor.TYPE_PROXIMITY);
            if (prox != null) {
                maxProximityRange = prox.getMaximumRange();
                if (sm.registerListener(sensorListener, prox, SensorManager.SENSOR_DELAY_NORMAL, sensorHandler)) {
                    registeredAny = true;
                }
            }

            Sensor light = sm.getDefaultSensor(Sensor.TYPE_LIGHT);
            if (light != null) {
                if (sm.registerListener(sensorListener, light, SensorManager.SENSOR_DELAY_NORMAL, sensorHandler)) {
                    registeredAny = true;
                }
            }

            Sensor grav = sm.getDefaultSensor(Sensor.TYPE_GRAVITY);
            if (grav != null) {
                if (sm.registerListener(sensorListener, grav, 1_000_000, 10_000_000, sensorHandler)) {
                    registeredAny = true;
                }
            } else {
                Sensor accel = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
                if (accel != null) {
                    if (sm.registerListener(sensorListener, accel, 1_000_000, 10_000_000, sensorHandler)) {
                        registeredAny = true;
                    }
                }
            }

            if (!registeredAny && sensorThread != null) {
                sensorThread.quitSafely();
                sensorThread = null;
                sensorHandler = null;
            }
            sensorsActive = registeredAny;
        } catch (Throwable ignored) {
            try {
                if (globalSensorManager != null) globalSensorManager.unregisterListener(sensorListener);
            } catch (Throwable ignored2) {}
            if (sensorThread != null) {
                try { sensorThread.quitSafely(); } catch (Throwable ignored3) {}
                sensorThread = null;
                sensorHandler = null;
            }
            sensorsActive = false;
        }
    }

    /**
     * Unregisters sensor listeners, stops the background thread, and flushes cached readings.
     */
    public static synchronized void stopSensors() {
        sensorsActive = false;
        if (globalSensorManager != null) {
            try {
                globalSensorManager.unregisterListener(sensorListener);
            } catch (Throwable ignored) {}
        }
        if (sensorThread != null) {
            try {
                sensorThread.quitSafely();
            } catch (Throwable ignored) {}
            sensorThread = null;
            sensorHandler = null;
        }
        lastProximity = null;
        lastLight = null;
        lastGravity = null;
    }

    /**
     * Resets sensor state for test harnesses.
     */
    public static synchronized void resetSensorsForTest() {
        stopSensors();
    }

    /**
     * Updates cached sensor readings for test harnesses.
     */
    static void updateSensorReadings(float proximityCm, float lightLux, float gravityZ) {
        sensorsActive = true;
        long nowNanos = SystemClock.elapsedRealtimeNanos();
        lastProximity = new SensorReading(proximityCm, nowNanos);
        lastLight = new SensorReading(lightLux, nowNanos);
        lastGravity = new SensorReading(gravityZ, nowNanos);
    }

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

            // 5. Physical Surface Telemetry
            JSONObject surface = collectPhysicalSurface(context);
            if (surface != null) root.put("physical_surface", surface);

            // 6. Network Telemetry
            JSONObject network = collectNetwork(context);
            if (network != null) root.put("network", network);

            // 7. Focus & Zen / DND Telemetry
            JSONObject focus = collectFocusAndDnd(context);
            if (focus != null) {
                root.put("focus", focus);
                root.put("dnd_active", focus.optBoolean("dnd_active", false));
                root.put("interruption_filter", focus.optString("interruption_filter", "UNKNOWN"));
            }
            if (audio != null) {
                root.put("car_audio_connected", audio.optBoolean("car_audio_connected", false));
            }

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

            // Detect Android Auto / Car mode
            boolean uiModeCar = false;
            try {
                android.app.UiModeManager uiModeManager = (android.app.UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
                if (uiModeManager != null && uiModeManager.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_CAR) {
                    uiModeCar = true;
                }
            } catch (Throwable ignored) {}

            int bestPriority = 0; // 0=none, 1=speaker, 2=wired, 3=bluetooth, 4=car_audio
            String outputType = "speaker";
            boolean carAudioConnected = false;

            if (uiModeCar) {
                bestPriority = 4;
                outputType = "car_audio";
                carAudioConnected = true;
            }

            // Detect audio output routing
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                if (devices != null) {
                    for (AudioDeviceInfo dev : devices) {
                        int type = dev.getType();

                        // 1. Android Automotive Audio Bus (API 24+)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && type == AudioDeviceInfo.TYPE_BUS) {
                            bestPriority = 4;
                            outputType = "car_audio";
                            carAudioConnected = true;
                            break;
                        }

                        // 2. Strict vehicle infotainment product name match (word-boundary regex)
                        CharSequence nameSeq = dev.getProductName();
                        if (nameSeq != null && CAR_AUDIO_NAME_PATTERN.matcher(nameSeq).find()) {
                            bestPriority = 4;
                            outputType = "car_audio";
                            carAudioConnected = true;
                            break;
                        }

                        // 3. Bluetooth audio output
                        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                                || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET)
                                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && type == AudioDeviceInfo.TYPE_HEARING_AID)) {
                            if (bestPriority < 3) {
                                bestPriority = 3;
                                outputType = "bluetooth_headset";
                            }
                        }
                        // 4. Wired or USB audio output
                        else if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                                || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                                || type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                            if (bestPriority < 2) {
                                bestPriority = 2;
                                outputType = "wired_headset";
                            }
                        }
                        // 5. Built-in speaker
                        else if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            if (bestPriority < 1) {
                                bestPriority = 1;
                                outputType = "speaker";
                            }
                        }
                    }
                }
            } else {
                if (uiModeCar) {
                    outputType = "car_audio";
                    carAudioConnected = true;
                } else if (am.isBluetoothA2dpOn() || am.isBluetoothScoOn()) {
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
            obj.put("car_audio_connected", carAudioConnected);

            return obj;
        } catch (Throwable t) {
            return null;
        }
    }

    public static JSONObject collectFocusAndDnd(Context context) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null;
            android.app.NotificationManager nm = (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return null;

            int filter = nm.getCurrentInterruptionFilter();
            String filterStr;
            boolean dndActive = false;

            switch (filter) {
                case android.app.NotificationManager.INTERRUPTION_FILTER_ALL:
                    filterStr = "ALL";
                    break;
                case android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY:
                    filterStr = "PRIORITY";
                    dndActive = true;
                    break;
                case android.app.NotificationManager.INTERRUPTION_FILTER_NONE:
                    filterStr = "NONE";
                    dndActive = true;
                    break;
                case android.app.NotificationManager.INTERRUPTION_FILTER_ALARMS:
                    filterStr = "ALARMS";
                    dndActive = true;
                    break;
                default:
                    filterStr = "UNKNOWN";
                    break;
            }

            JSONObject obj = new JSONObject();
            obj.put("interruption_filter", filterStr);
            obj.put("dnd_active", dndActive);
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

    /**
     * Pure deterministic classifier for physical surface & pocket placement.
     */
    public static String classifyState(
            float proxVal,
            float maxRange,
            float lux,
            float gravZ,
            boolean hasGrav,
            boolean inCall,
            boolean isInteractive
    ) {
        boolean binary = maxRange <= 10.0f;
        boolean isNear = proxVal >= 0 && (binary ? proxVal < maxRange : proxVal < 1.0f);
        boolean isDark = lux >= 0 && lux < 5.0f;

        if (isNear && inCall) {
            return "at_ear";
        }
        // If the screen is on and interactive, user is actively holding and viewing device
        if (isInteractive) {
            return "handheld";
        }
        if (isNear && hasGrav && gravZ < -7.0f) {
            return "face_down";
        }
        if (hasGrav && gravZ < -7.0f && isDark) {
            return "face_down";
        }
        if (isNear && isDark) {
            return "in_pocket";
        }
        if (hasGrav && gravZ > 7.0f && !isNear) {
            return "desk_ambient";
        }
        if (hasGrav && (gravZ >= -7.0f && gravZ <= 7.0f)) {
            return "handheld";
        }
        return "unknown";
    }

    /**
     * Collects deterministic physical surface and pocket classification.
     * Uses hardware proximity, ambient lux, and gravity Z-axis readings.
     * Proximity and Light are on-change sensors in Android and retain their latched state.
     * Gravity/accelerometer is a continuous sensor and enforces a 30s freshness window.
     */
    public static JSONObject collectPhysicalSurface(Context context) {
        try {
            if (!sensorsActive || context == null) {
                return null;
            }

            long nowNanos = SystemClock.elapsedRealtimeNanos();
            SensorReading prox = lastProximity;
            SensorReading light = lastLight;
            SensorReading grav = lastGravity;

            boolean hasGrav = (grav != null && (nowNanos - grav.elapsedNanos <= SENSOR_STALE_NANOS));
            float gravZ = hasGrav ? grav.value : 0.0f;

            // Proximity and light are on-change sensors: they only deliver events on state changes.
            // Retain the last observed reading while sensors remain active.
            float proxVal = prox != null ? prox.value : -1.0f;
            float lux = light != null ? light.value : -1.0f;

            if (proxVal < 0 && lux < 0 && !hasGrav) {
                return null;
            }

            JSONObject obj = new JSONObject();
            if (proxVal >= 0 && !Float.isNaN(proxVal) && !Float.isInfinite(proxVal)) {
                obj.put("proximity_cm", (double) proxVal);
            }
            if (lux >= 0 && !Float.isNaN(lux) && !Float.isInfinite(lux)) {
                obj.put("lux", (double) lux);
            }
            if (hasGrav && !Float.isNaN(gravZ) && !Float.isInfinite(gravZ)) {
                obj.put("gravity_z", (double) gravZ);
            }

            // In-call check: phone held against ear during active call/meeting emits "at_ear"
            boolean inCall = false;
            try {
                AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    int mode = am.getMode();
                    inCall = (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION);
                }
            } catch (Throwable ignored) {}

            // Screen interactive check: if user is actively using display, prevent false in_pocket
            boolean isInteractive = false;
            try {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    isInteractive = pm.isInteractive();
                }
            } catch (Throwable ignored) {}

            String state = classifyState(proxVal, maxProximityRange, lux, gravZ, hasGrav, inCall, isInteractive);
            obj.put("state", state);
            return obj;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Collects network quality, transport type, and unmetered vs metered gating status.
     * Derives metered status from NetworkCapabilities directly on API 23+ or ConnectivityManager.
     */
    public static JSONObject collectNetwork(Context context) {
        if (context == null) return null;
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;

            JSONObject obj = new JSONObject();
            String transport = "unknown";
            int downstreamKbps = -1;
            int upstreamKbps = -1;
            boolean validated = false;
            boolean connected = false;
            boolean isVpn = false;
            boolean metered = false;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network activeNet = cm.getActiveNetwork();
                if (activeNet != null) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
                    if (caps != null) {
                        connected = true;
                        metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                        validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                        isVpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);

                        // Prioritize VPN for transport reporting
                        if (isVpn) {
                            transport = "vpn";
                        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            transport = "wifi";
                        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                            transport = "cellular";
                        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                            transport = "ethernet";
                        } else {
                            transport = "other";
                        }

                        downstreamKbps = caps.getLinkDownstreamBandwidthKbps();
                        upstreamKbps = caps.getLinkUpstreamBandwidthKbps();
                    }
                }
            } else {
                NetworkInfo info = cm.getActiveNetworkInfo();
                if (info != null && info.isConnected()) {
                    connected = true;
                    int type = info.getType();
                    if (type == ConnectivityManager.TYPE_VPN) {
                        transport = "vpn";
                        isVpn = true;
                    } else if (type == ConnectivityManager.TYPE_WIFI) {
                        transport = "wifi";
                    } else if (type == ConnectivityManager.TYPE_MOBILE) {
                        transport = "cellular";
                    } else if (type == ConnectivityManager.TYPE_ETHERNET) {
                        transport = "ethernet";
                    } else {
                        transport = "other";
                    }

                    metered = cm.isActiveNetworkMetered();
                }
            }

            obj.put("connected", connected);
            if (connected) {
                obj.put("transport", transport);
                obj.put("metered", metered);
                obj.put("vpn", isVpn);
                if (downstreamKbps > 0) obj.put("downstream_kbps", downstreamKbps);
                if (upstreamKbps > 0) obj.put("upstream_kbps", upstreamKbps);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    obj.put("validated", validated);
                }
            } else {
                obj.put("transport", "none");
                // Do not emit "metered" when offline so consumers do not treat offline as unmetered
            }

            return obj;
        } catch (Throwable t) {
            return null;
        }
    }
}
