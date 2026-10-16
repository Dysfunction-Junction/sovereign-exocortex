package com.pieces.android.companion;

import android.app.PendingIntent;
import android.util.Log;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Thread-safe bounded LRU registry for native Notification.Action PendingIntents.
 * Allows the Sovereign Exocortex UI (Obsidian Glass) and shadow actuation plane
 * to trigger 1-tap notification actions (Archive, Mark as Read, etc.) natively.
 */
public final class NotificationActionRegistry {

    private static final String TAG = "NotifActionRegistry";
    private static final int MAX_ACTIONS = 100;

    private static final Map<String, PendingIntent> actionMap = new LinkedHashMap<String, PendingIntent>(MAX_ACTIONS, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, PendingIntent> eldest) {
            return size() > MAX_ACTIONS;
        }
    };

    private NotificationActionRegistry() {}

    /**
     * Registers a pending action intent under a deterministic action ID.
     */
    public static synchronized void register(String actionId, PendingIntent intent) {
        if (actionId == null || intent == null) return;
        actionMap.put(actionId, intent);
    }

    /**
     * Retrieves a registered pending action intent.
     */
    public static synchronized PendingIntent get(String actionId) {
        if (actionId == null) return null;
        return actionMap.get(actionId);
    }

    /**
     * Executes the registered notification action.
     * Returns true if successfully dispatched, false otherwise.
     */
    public static boolean execute(String actionId) {
        PendingIntent intent;
        synchronized (NotificationActionRegistry.class) {
            intent = actionMap.remove(actionId);
        }
        if (intent == null) {
            Log.w(TAG, "No pending intent registered for actionId: " + actionId);
            return false;
        }
        try {
            intent.send();
            Log.i(TAG, "Successfully executed notification action: " + actionId);
            return true;
        } catch (PendingIntent.CanceledException e) {
            Log.w(TAG, "Notification action was cancelled: " + actionId, e);
            return false;
        } catch (Throwable t) {
            Log.e(TAG, "Failed to execute notification action: " + actionId, t);
            return false;
        }
    }

    /**
     * Clears all registered action intents (useful during tests or service resets).
     */
    public static synchronized void clear() {
        actionMap.clear();
    }
}
