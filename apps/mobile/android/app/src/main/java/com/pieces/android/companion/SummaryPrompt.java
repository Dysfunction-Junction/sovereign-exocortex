package com.pieces.android.companion;

/**
 * Pure prompt builder for on-device summarization (A5-1 Section 4.6 & 6.1).
 * Verbatim text per spec; package name and app label are never included.
 */
final class SummaryPrompt {
    private SummaryPrompt() {}

    static String build(String appCategory, char[] text) {
        String category = appCategory != null ? appCategory : "other";
        String content = text != null ? new String(text) : "";
        return "You write privacy-safe notes. Read the text and answer with ONLY one JSON object, no other text:\n"
            + "{\"intent\":\"<one of: plan, ask, tell, decide, remind, vent, other>\",\n"
            + " \"topics\":[\"<up to 3 from the list>\"],\n"
            + " \"entity_types\":[\"<any of: person, place, org, date, money, product>\"],\n"
            + " \"summary\":\"<at most 20 words>\"}\n"
            + "Topic list: planning, scheduling, shopping, travel, food, home, family, work_task, coding, writing, learning, entertainment, music, gaming, news, car, pets, weather, sports, event, gift, appointment, logistics, idea, question, update, other.\n"
            + "Rules for summary: describe what the text is about in general terms. Do NOT include names, numbers, addresses, emails, links, quotes or any exact phrase from the text.\n"
            + "App type: " + category + "\n"
            + "Text:\n"
            + "\"\"\"\n"
            + content + "\n"
            + "\"\"\"";
    }
}
