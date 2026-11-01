package com.pieces.android.companion;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Pure validation guard for model outputs (A5-1 Section 4.7 & 6.3).
 */
final class SummaryGuard {
    private SummaryGuard() {}

    static final class Summary {
        final String intent;
        final List<String> topics;
        final List<String> entityTypes;
        final String summary;
        final String strippedReason; // null if intact, else name of reason

        Summary(String intent, List<String> topics, List<String> entityTypes, String summary, String strippedReason) {
            this.intent = intent;
            this.topics = topics;
            this.entityTypes = entityTypes;
            this.summary = summary != null ? summary : "";
            this.strippedReason = strippedReason;
        }

        JSONObject toJson() {
            try {
                JSONObject json = new JSONObject();
                json.put("intent", intent);
                json.put("topics", new JSONArray(topics));
                json.put("entity_types", new JSONArray(entityTypes));
                json.put("summary", summary);
                if (strippedReason != null) {
                    json.put("stripped_reason", strippedReason);
                }
                return json;
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    static final class GuardResult {
        final boolean isOk;
        final Summary summary;
        final String rejectReason;

        private GuardResult(boolean isOk, Summary summary, String rejectReason) {
            this.isOk = isOk;
            this.summary = summary;
            this.rejectReason = rejectReason;
        }

        static GuardResult ok(Summary s) {
            return new GuardResult(true, s, null);
        }

        static GuardResult reject(String reason) {
            return new GuardResult(false, null, reason);
        }
    }

    private static final Set<String> ALLOWED_INTENTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "plan", "ask", "tell", "decide", "remind", "vent", "other"
    )));

    private static final Set<String> VALID_TOPICS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "planning", "scheduling", "shopping", "travel", "food", "home", "family",
        "work_task", "coding", "writing", "learning", "entertainment", "music",
        "gaming", "news", "car", "pets", "weather", "sports", "event", "gift",
        "appointment", "logistics", "idea", "question", "update", "other"
    )));

    private static final Set<String> VALID_ENTITY_TYPES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "person", "place", "org", "date", "money", "product"
    )));

    private static final Pattern DIGITS_PATTERN = Pattern.compile("\\d{3,}");
    private static final Pattern EMAIL_PATTERN = Pattern.compile("[\\w.+-]+@[\\w-]+\\.[\\w.-]+");
    private static final Pattern URL_PATTERN = Pattern.compile("(?i)(https?://|www\\.)\\S+|\\b\\w+\\.(com|net|org|io|app|dev|gov|edu)\\b");
    private static final Pattern PHONE_PATTERN = Pattern.compile("\\+?\\d[\\d\\s().-]{6,}\\d");
    private static final Pattern TOKEN_PATTERN = Pattern.compile("\\p{L}[\\p{L}\\p{Nd}'’-]*");
    private static final Pattern WORD_PATTERN = Pattern.compile("\\p{L}+");

    static GuardResult check(String raw, char[] inputChars) {
        if (raw == null) return GuardResult.reject("no_json");
        try {
            int firstBrace = raw.indexOf('{');
            int lastBrace = raw.lastIndexOf('}');
            if (firstBrace == -1 || lastBrace == -1 || lastBrace < firstBrace) {
                return GuardResult.reject("no_json");
            }
            String jsonSub = raw.substring(firstBrace, lastBrace + 1);
            JSONObject obj;
            try {
                obj = new JSONObject(jsonSub);
            } catch (Exception e) {
                return GuardResult.reject("bad_json");
            }

            // 2. Intent check
            String intent = obj.optString("intent", "").toLowerCase(Locale.ROOT).trim();
            if (!ALLOWED_INTENTS.contains(intent)) {
                return GuardResult.reject("bad_intent");
            }

            // 3. Topics check
            JSONArray topicsArr = obj.optJSONArray("topics");
            Set<String> topicsSet = new LinkedHashSet<>();
            if (topicsArr != null) {
                for (int i = 0; i < topicsArr.length() && topicsSet.size() < 3; i++) {
                    String t = topicsArr.optString(i, "").toLowerCase(Locale.ROOT).trim();
                    if (!t.isEmpty()) {
                        if (VALID_TOPICS.contains(t)) {
                            topicsSet.add(t);
                        } else {
                            topicsSet.add("other");
                        }
                    }
                }
            }
            if (topicsSet.isEmpty()) {
                topicsSet.add("other");
            }
            List<String> topics = new ArrayList<>(topicsSet);

            // 4. Entity types check
            JSONArray entityArr = obj.optJSONArray("entity_types");
            List<String> entityTypes = new ArrayList<>();
            if (entityArr != null) {
                for (int i = 0; i < entityArr.length(); i++) {
                    String et = entityArr.optString(i, "").toLowerCase(Locale.ROOT).trim();
                    if (VALID_ENTITY_TYPES.contains(et) && !entityTypes.contains(et)) {
                        entityTypes.add(et);
                    }
                }
            }

            // 5. Summary checks
            String candidateSummary = obj.optString("summary", "").trim();
            String inputText = inputChars != null ? new String(inputChars) : "";
            String strippedReason = checkSummary(candidateSummary, inputText);

            String finalSummary = (strippedReason == null) ? candidateSummary : "";
            return GuardResult.ok(new Summary(intent, topics, entityTypes, finalSummary, strippedReason));

        } catch (Throwable t) {
            return GuardResult.reject("guard_error");
        }
    }

    private static String checkSummary(String summary, String input) {
        if (summary.isEmpty()) return null;

        // 5a. length > 160 chars or > 20 words
        if (summary.length() > 160) return "too_long";
        String[] words = summary.trim().split("\\s+");
        if (words.length > 20) return "too_long";

        // 5b. regex \d{3,} or runs of 3+ digits with spaces/dots/dashes stripped
        if (DIGITS_PATTERN.matcher(summary).find()) return "digits";
        String digitsOnly = summary.replaceAll("[\\s.\\-]+", "");
        if (DIGITS_PATTERN.matcher(digitsOnly).find()) return "digits";

        // 5c. email
        if (EMAIL_PATTERN.matcher(summary).find()) return "email";

        // 5d. URL
        if (URL_PATTERN.matcher(summary).find()) return "url";

        // 5e. phone
        if (PHONE_PATTERN.matcher(summary).find()) return "phone";

        // 5f. quotes: " or curly quote pair
        if (summary.contains("\"") || (summary.contains("“") && summary.contains("”")) || (summary.contains("‘") && summary.contains("’"))) {
            return "quote";
        }

        // 5g. Capitalized-token echo
        Set<String> sensitiveTokens = extractNonInitialCapitalizedTokens(input);
        if (!sensitiveTokens.isEmpty()) {
            List<String> summaryWords = tokenizeWords(summary);
            for (String sw : summaryWords) {
                if (sensitiveTokens.contains(sw.toLowerCase(Locale.ROOT))) {
                    return "name_echo";
                }
            }
        }

        // 5h. 4-gram echo
        List<String> inputWords = tokenizeWords(input.toLowerCase(Locale.ROOT));
        List<String> summaryWords = tokenizeWords(summary.toLowerCase(Locale.ROOT));
        if (hasConsecutive4Gram(summaryWords, inputWords)) {
            return "verbatim";
        }

        return null;
    }

    private static class TokenPos {
        final String token;
        final boolean isSentenceInitial;

        TokenPos(String token, boolean isSentenceInitial) {
            this.token = token;
            this.isSentenceInitial = isSentenceInitial;
        }
    }

    private static Set<String> extractNonInitialCapitalizedTokens(String text) {
        Set<String> set = new HashSet<>();
        List<TokenPos> tokens = tokenize(text);
        for (TokenPos tp : tokens) {
            if (!tp.isSentenceInitial && !tp.token.isEmpty() && Character.isUpperCase(tp.token.charAt(0))) {
                set.add(tp.token.toLowerCase(Locale.ROOT));
            }
        }
        return set;
    }

    private static List<TokenPos> tokenize(String text) {
        List<TokenPos> list = new ArrayList<>();
        if (text == null || text.isEmpty()) return list;

        boolean atSentenceStart = true;
        Matcher m = TOKEN_PATTERN.matcher(text);
        int lastEnd = 0;

        while (m.find()) {
            String skipped = text.substring(lastEnd, m.start());
            for (int i = 0; i < skipped.length(); i++) {
                char c = skipped.charAt(i);
                if (c == '.' || c == '!' || c == '?' || c == '\n' || c == '\r') {
                    atSentenceStart = true;
                }
            }

            String token = m.group();
            list.add(new TokenPos(token, atSentenceStart));
            atSentenceStart = false;
            lastEnd = m.end();
        }
        return list;
    }

    private static List<String> tokenizeWords(String text) {
        List<String> list = new ArrayList<>();
        if (text == null) return list;
        Matcher m = WORD_PATTERN.matcher(text);
        while (m.find()) {
            list.add(m.group());
        }
        return list;
    }

    private static boolean hasConsecutive4Gram(List<String> needleWords, List<String> haystackWords) {
        if (needleWords.size() < 4 || haystackWords.size() < 4) return false;
        for (int i = 0; i <= needleWords.size() - 4; i++) {
            String w0 = needleWords.get(i);
            String w1 = needleWords.get(i + 1);
            String w2 = needleWords.get(i + 2);
            String w3 = needleWords.get(i + 3);

            for (int j = 0; j <= haystackWords.size() - 4; j++) {
                if (w0.equals(haystackWords.get(j)) &&
                    w1.equals(haystackWords.get(j + 1)) &&
                    w2.equals(haystackWords.get(j + 2)) &&
                    w3.equals(haystackWords.get(j + 3))) {
                    return true;
                }
            }
        }
        return false;
    }
}
