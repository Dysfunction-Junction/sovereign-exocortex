package com.pieces.android.companion;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.Telephony;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Part 2 of the capture stack: full SMS bodies + backfill of existing history.
 *
 * Capture model: an ALLOWLIST of contacts. listContacts() populates a picker;
 * setAllowlist() saves the chosen phone numbers (normalized to digits). backfill()
 * only returns messages whose sender/recipient is on that list — so OTP
 * shortcodes, spam, and unknown numbers are excluded by default, and the user
 * opts in per contact rather than trying to enumerate everything to block.
 *
 * READ_SMS / READ_CONTACTS have no runtime dialog for a non-default-SMS app;
 * the user grants them via the app details settings screen (openAppSettings)
 * or, on Android 14+, the one-time restricted-settings flow. Everything here
 * is inert until READ_SMS exists; the contact picker additionally needs
 * READ_CONTACTS.
 */
@CapacitorPlugin(name = "SmsReader")
public class SmsPlugin extends Plugin {

    private static final int MAX_BODY_CHARS = 8_000;
    private static final String SMS_ALLOWLIST_KEY = "sms_contact_allowlist";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, String> contactCache = new HashMap<>();

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", granted());
        ret.put("contactsGranted", contactsGranted());
        call.resolve(ret);
    }

    /** Open app details settings screen for manual permission grants. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * All contacts that have at least one phone number that sent an inbound SMS
     * during the current year (excluding short codes and OTPs), for the allowlist picker.
     * Returns { contacts: [{ name, numbers: [digits...] }] }, name-sorted.
     */
    @PluginMethod
    public void listContacts(PluginCall call) {
        if (!contactsGranted()) { call.reject("READ_CONTACTS not granted"); return; }
        executor.execute(() -> {
            try {
                // 1) Calculate start of current year (e.g. Jan 1, 2026 00:00:00)
                java.util.Calendar cal = java.util.Calendar.getInstance();
                cal.set(java.util.Calendar.DAY_OF_YEAR, 1);
                cal.set(java.util.Calendar.HOUR_OF_DAY, 0);
                cal.set(java.util.Calendar.MINUTE, 0);
                cal.set(java.util.Calendar.SECOND, 0);
                cal.set(java.util.Calendar.MILLISECOND, 0);
                long startOfYear = cal.getTimeInMillis();

                // 2) Find distinct normalized addresses from SMS inbox from this year only,
                //    rejecting short codes and automated OTPs (< 10 digits).
                Set<String> activeInboundNumbers = new HashSet<>();
                try (Cursor c = getContext().getContentResolver().query(
                        Telephony.Sms.Inbox.CONTENT_URI,
                        new String[]{"DISTINCT " + Telephony.Sms.ADDRESS},
                        Telephony.Sms.DATE + " >= ?",
                        new String[]{String.valueOf(startOfYear)},
                        null)) {
                    while (c != null && c.moveToNext()) {
                        String raw = c.getString(0);
                        if (raw != null) {
                            String norm = normalize(raw);
                            if (norm.length() >= 10 && norm.length() <= 15) {
                                activeInboundNumbers.add(norm);
                            }
                        }
                    }
                }

                // 3) name -> set of normalized numbers, filtered to contacts who have sent messages this year
                Map<String, Set<String>> byName = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                try (Cursor c = getContext().getContentResolver().query(
                        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        new String[]{
                            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                            ContactsContract.CommonDataKinds.Phone.NUMBER,
                        },
                        null, null,
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
                    while (c != null && c.moveToNext()) {
                        String name = c.getString(0);
                        String number = normalize(c.getString(1));
                        if (name == null || name.trim().isEmpty() || number.isEmpty()) continue;
                        if (!activeInboundNumbers.contains(number)) continue;
                        byName.computeIfAbsent(name.trim(), k -> new java.util.LinkedHashSet<>()).add(number);
                    }
                }

                JSArray contacts = new JSArray();
                for (Map.Entry<String, Set<String>> e : byName.entrySet()) {
                    JSObject o = new JSObject();
                    o.put("name", e.getKey());
                    JSArray nums = new JSArray();
                    for (String n : e.getValue()) nums.put(n);
                    o.put("numbers", nums);
                    contacts.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("contacts", contacts);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Contact query failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getAllowlist(PluginCall call) {
        JSArray result = new JSArray();
        for (String n : allowlist()) result.put(n);
        JSObject ret = new JSObject();
        ret.put("numbers", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void setAllowlist(PluginCall call) {
        JSArray numbers = call.getArray("numbers");
        Set<String> next = new HashSet<>();
        if (numbers != null) {
            try {
                for (int i = 0; i < numbers.length(); i++) {
                    String n = normalize(numbers.getString(i));
                    if (!n.isEmpty()) next.add(n);
                }
            } catch (org.json.JSONException je) {
                call.reject("Bad numbers array: " + je.getMessage());
                return;
            }
        }
        prefs().edit().putStringSet(SMS_ALLOWLIST_KEY, next).apply();
        JSObject ret = new JSObject();
        ret.put("status", "saved");
        ret.put("count", next.size());
        call.resolve(ret);
    }

    /** Newest message date in the store, for incremental backfill bookkeeping. */
    @PluginMethod
    public void latestMessageDate(PluginCall call) {
        if (!granted()) { call.reject("READ_SMS not granted"); return; }
        executor.execute(() -> {
            long latest = 0;
            try (Cursor c = getContext().getContentResolver().query(
                    Telephony.Sms.CONTENT_URI,
                    new String[]{Telephony.Sms.DATE},
                    null, null, Telephony.Sms.DATE + " DESC LIMIT 1")) {
                if (c != null && c.moveToFirst()) latest = c.getLong(0);
                JSObject ret = new JSObject();
                ret.put("date", latest);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Query failed: " + e.getMessage());
            }
        });
    }

    /**
     * One page of SMS history, oldest-first, strictly after sinceMillis, filtered
     * to the contact allowlist. Returns
     * { messages: [{ id, address, contactName, body, date, direction }], hasMore, scanned }.
     *
     * `scanned` is how many rows were read from the provider (allowlist or not),
     * so the JS side can advance its high-water mark past filtered-out messages
     * instead of re-scanning them forever.
     */
    @PluginMethod
    public void backfill(PluginCall call) {
        if (!granted()) { call.reject("READ_SMS not granted"); return; }
        final long since = call.getLong("sinceMillis", 0L);
        final int limit = Math.max(1, Math.min(1000, call.getInt("limit", 200)));
        final Set<String> allow = allowlist();

        executor.execute(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                // Scan a wider window than `limit` since most rows may be filtered
                // out by the allowlist; cap the scan so one call stays bounded.
                final int scanCap = Math.min(4000, limit * 10);

                // Two providers hold texts: the SMS table, and the MMS table (messages the default
                // messaging app stores as MMS: chat/RCS-style messages, group and picture messages).
                // Reading only SMS silently lost every recent message of the second kind.
                List<Raw> rows = new ArrayList<>();
                long smsLast = since;
                long mmsLast = since;

                int smsRows = 0;
                try (Cursor c = cr.query(
                        Telephony.Sms.CONTENT_URI,
                        new String[]{
                            Telephony.Sms._ID,
                            Telephony.Sms.ADDRESS,
                            Telephony.Sms.BODY,
                            Telephony.Sms.DATE,
                            Telephony.Sms.TYPE,
                        },
                        Telephony.Sms.DATE + " > ?",
                        new String[]{String.valueOf(since)},
                        Telephony.Sms.DATE + " ASC LIMIT " + scanCap)) {
                    while (c != null && c.moveToNext()) {
                        smsRows++;
                        Raw r = new Raw();
                        r.mms = false;
                        r.id = c.getString(0);
                        r.address = c.getString(1) != null ? c.getString(1) : "";
                        r.body = c.getString(2) != null ? c.getString(2) : "";
                        r.dateMs = c.getLong(3);
                        r.type = c.getInt(4);
                        smsLast = r.dateMs;
                        rows.add(r);
                    }
                }
                final boolean smsCapped = smsRows >= scanCap;

                int mmsRows = 0;
                try (Cursor c = cr.query(
                        Uri.parse("content://mms"),
                        new String[]{"_id", "date", "msg_box"},
                        "date > ? AND msg_box IN (1, 2)",
                        new String[]{String.valueOf(since / 1000L)},
                        "date ASC LIMIT " + scanCap)) {
                    while (c != null && c.moveToNext()) {
                        mmsRows++;
                        Raw r = new Raw();
                        r.mms = true;
                        r.id = "mms-" + c.getString(0);
                        long d = c.getLong(1);
                        r.dateMs = d < 100_000_000_000L ? d * 1000L : d; // MMS dates are in seconds
                        r.type = c.getInt(2); // msg_box: 1 inbox, 2 sent
                        mmsLast = r.dateMs;
                        rows.add(r);
                    }
                } catch (Exception ignored) {
                    // No MMS provider access: carry on with SMS only.
                }
                final boolean mmsCapped = mmsRows >= scanCap;

                Collections.sort(rows, (a, b) -> Long.compare(a.dateMs, b.dateMs));

                // If a source was cut off at the cap, rows of the other source past that point could be
                // preceded by unread rows of the capped one: stop at that horizon.
                long horizon = Long.MAX_VALUE;
                if (smsCapped) horizon = Math.min(horizon, smsLast);
                if (mmsCapped) horizon = Math.min(horizon, mmsLast);

                JSArray messages = new JSArray();
                int kept = 0;
                int scanned = 0;
                long lastScannedDate = since;
                boolean hasMore = smsCapped || mmsCapped;

                for (int i = 0; i < rows.size(); i++) {
                    Raw r = rows.get(i);
                    if (r.dateMs > horizon) { hasMore = true; break; }
                    scanned++;
                    lastScannedDate = r.dateMs;

                    String address;
                    String body;
                    String direction;
                    if (r.mms) {
                        MmsInfo info = readMms(cr, r.id.substring(4), r.type == 1, allow);
                        if (info == null) continue; // not on the allowlist, or nothing to read
                        address = info.address;
                        body = info.body;
                        direction = r.type == 1 ? "inbound" : "outbound";
                    } else {
                        address = r.address;
                        if (!allow.contains(normalize(address))) continue;
                        body = r.body;
                        switch (r.type) {
                            case Telephony.Sms.MESSAGE_TYPE_INBOX:  direction = "inbound";  break;
                            case Telephony.Sms.MESSAGE_TYPE_SENT:    direction = "outbound"; break;
                            case Telephony.Sms.MESSAGE_TYPE_DRAFT:   direction = "draft";    break;
                            case Telephony.Sms.MESSAGE_TYPE_OUTBOX:  direction = "outbound"; break;
                            default:                                 direction = "other";   break;
                        }
                    }
                    if (body.length() > MAX_BODY_CHARS) body = body.substring(0, MAX_BODY_CHARS);

                    JSObject m = new JSObject();
                    m.put("id", r.id);
                    m.put("address", address);
                    m.put("contactName", lookupContact(address));
                    m.put("body", body);
                    m.put("date", r.dateMs);
                    m.put("direction", direction);
                    messages.put(m);

                    kept++;
                    if (kept >= limit) {
                        if (i + 1 < rows.size()) hasMore = true;
                        break;
                    }
                }

                JSObject ret = new JSObject();
                ret.put("messages", messages);
                ret.put("hasMore", hasMore);
                ret.put("scanned", scanned);
                ret.put("lastScannedDate", lastScannedDate);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Backfill query failed: " + e.getMessage());
            }
        });
    }

    private static final class Raw {
        boolean mms;
        String id;
        String address;
        String body;
        long dateMs;
        int type;
    }

    private static final class MmsInfo {
        String address;
        String body;
    }

    /**
     * Text and counterpart of one MMS-table message, or null when nobody on the allowlist took part
     * or it has no text part (a bare picture). Participants come from the addr table: type 137 is the
     * sender, 151 a recipient; a message counts if any of them is allowlisted.
     */
    private MmsInfo readMms(ContentResolver cr, String mmsId, boolean inbound, Set<String> allow) {
        String match = null;
        try (Cursor a = cr.query(Uri.parse("content://mms/" + mmsId + "/addr"),
                new String[]{"address", "type"}, null, null, null)) {
            while (a != null && a.moveToNext()) {
                String addr = a.getString(0);
                int type = a.getInt(1);
                if (addr == null || addr.isEmpty() || addr.contains("insert-address-token")) continue;
                if (type != 137 && type != 151) continue;
                if (allow.contains(normalize(addr))) {
                    // Prefer the counterpart: the sender of an inbound, a recipient of an outbound.
                    boolean counterpart = inbound ? type == 137 : type == 151;
                    if (match == null || counterpart) match = addr;
                }
            }
        } catch (Exception e) {
            return null;
        }
        if (match == null) return null;

        StringBuilder text = new StringBuilder();
        try (Cursor p = cr.query(Uri.parse("content://mms/part"),
                new String[]{"text"}, "mid = ? AND ct = 'text/plain'", new String[]{mmsId}, "seq ASC")) {
            while (p != null && p.moveToNext()) {
                String t = p.getString(0);
                if (t != null && !t.isEmpty()) {
                    if (text.length() > 0) text.append("\n");
                    text.append(t);
                }
            }
        } catch (Exception e) {
            return null;
        }
        if (text.length() == 0) return null;
        MmsInfo info = new MmsInfo();
        info.address = match;
        info.body = text.toString();
        return info;
    }

    // ---------------------------------------------------------------------

    private boolean granted() {
        return getContext().checkSelfPermission(Manifest.permission.READ_SMS)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean contactsGranted() {
        return getContext().checkSelfPermission(Manifest.permission.READ_CONTACTS)
            == PackageManager.PERMISSION_GRANTED;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(AccessibilityPlugin.PREFS_NAME, Context.MODE_PRIVATE);
    }

    private Set<String> allowlist() {
        return new HashSet<>(prefs().getStringSet(SMS_ALLOWLIST_KEY, new HashSet<>()));
    }

    /** Reduce a phone number / short code to a comparable key: digits only, and
     *  for 11-digit US numbers drop a leading country-code 1 so "+1 555…" and
     *  "555…" match. Short codes (< 7 digits) are kept as-is. */
    private static String normalize(String raw) {
        if (raw == null) return "";
        String digits = raw.replaceAll("[^0-9]", "");
        if (digits.length() == 11 && digits.startsWith("1")) digits = digits.substring(1);
        return digits;
    }

    /** Best-effort number -> contact name for display. */
    private String lookupContact(String address) {
        if (address == null || address.isEmpty()) return "";
        String cached = contactCache.get(address);
        if (cached != null) return cached;
        String name = "";
        try {
            Uri uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address));
            try (Cursor c = getContext().getContentResolver().query(
                    uri, new String[]{ContactsContract.PhoneLookup.DISPLAY_NAME},
                    null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            }
        } catch (Exception ignored) {}
        contactCache.put(address, name);
        return name;
    }
}
