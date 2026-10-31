package com.pieces.android.companion;

import static org.junit.Assert.*;

import java.util.Arrays;
import org.junit.Test;

public class SummaryGuardTest {

    @Test
    public void validSummaryPassesUnstripped() {
        String input = "Let's organize the living room this weekend and get a new rug.";
        String modelOutput = "{\"intent\":\"plan\",\"topics\":[\"home\",\"planning\"],\"entity_types\":[\"product\"],\"summary\":\"Planning to organize room and buy home goods.\"}";

        SummaryGuard.GuardResult res = SummaryGuard.check(modelOutput, input.toCharArray());
        assertTrue(res.isOk);
        assertEquals("plan", res.summary.intent);
        assertEquals(Arrays.asList("home", "planning"), res.summary.topics);
        assertEquals(Arrays.asList("product"), res.summary.entityTypes);
        assertEquals("Planning to organize room and buy home goods.", res.summary.summary);
        assertNull(res.summary.strippedReason);
    }

    @Test
    public void unparseableOutputRejected() {
        SummaryGuard.GuardResult r1 = SummaryGuard.check("I am not JSON", "text".toCharArray());
        assertFalse(r1.isOk);
        assertEquals("no_json", r1.rejectReason);

        SummaryGuard.GuardResult r2 = SummaryGuard.check("{\"invalid_json\": }", "text".toCharArray());
        assertFalse(r2.isOk);
        assertEquals("bad_json", r2.rejectReason);
    }

    @Test
    public void invalidIntentRejected() {
        String output = "{\"intent\":\"attack\",\"topics\":[\"other\"],\"summary\":\"some text\"}";
        SummaryGuard.GuardResult res = SummaryGuard.check(output, "text".toCharArray());
        assertFalse(res.isOk);
        assertEquals("bad_intent", res.rejectReason);
    }

    @Test
    public void outOfListTopicBecomesOther() {
        String output = "{\"intent\":\"ask\",\"topics\":[\"cryptocurrency\",\"politics\",\"coding\"],\"summary\":\"Asking coding question.\"}";
        SummaryGuard.GuardResult res = SummaryGuard.check(output, "text".toCharArray());
        assertTrue(res.isOk);
        // "cryptocurrency" and "politics" become "other", deduplicated
        assertTrue(res.summary.topics.contains("other"));
        assertTrue(res.summary.topics.contains("coding"));
        assertTrue(res.summary.topics.size() <= 3);
    }

    @Test
    public void digitsAndPhoneAreStripped() {
        String input = "Please call Dana at 555-0134 tomorrow morning.";
        String outputWithPhone = "{\"intent\":\"remind\",\"topics\":[\"appointment\"],\"summary\":\"Call Dana at 555-0134\"}";

        SummaryGuard.GuardResult res = SummaryGuard.check(outputWithPhone, input.toCharArray());
        assertTrue(res.isOk);
        assertEquals("", res.summary.summary);
        assertNotNull(res.summary.strippedReason);
        assertTrue(res.summary.strippedReason.equals("digits") || res.summary.strippedReason.equals("phone"));
    }

    @Test
    public void nameEchoIsStripped() {
        // "Dana" is capitalized and NOT sentence initial in the input
        String input = "Please call Dana tomorrow about the schedule.";

        // Middle of sentence
        String outputWithName = "{\"intent\":\"plan\",\"topics\":[\"planning\"],\"summary\":\"Organizing call with Dana tomorrow.\"}";
        SummaryGuard.GuardResult res = SummaryGuard.check(outputWithName, input.toCharArray());
        assertTrue(res.isOk);
        assertEquals("", res.summary.summary);
        assertEquals("name_echo", res.summary.strippedReason);

        // Sentence initial in output: "Dana needs a call."
        String outputInitial = "{\"intent\":\"plan\",\"topics\":[\"planning\"],\"summary\":\"Dana needs a call.\"}";
        SummaryGuard.GuardResult resInitial = SummaryGuard.check(outputInitial, input.toCharArray());
        assertTrue(resInitial.isOk);
        assertEquals("", resInitial.summary.summary);
        assertEquals("name_echo", resInitial.summary.strippedReason);

        // Lowercase in output: "dana needs a call."
        String outputLower = "{\"intent\":\"plan\",\"topics\":[\"planning\"],\"summary\":\"dana needs a call.\"}";
        SummaryGuard.GuardResult resLower = SummaryGuard.check(outputLower, input.toCharArray());
        assertTrue(resLower.isOk);
        assertEquals("", resLower.summary.summary);
        assertEquals("name_echo", resLower.summary.strippedReason);
    }

    @Test
    public void verbatimFourGramIsStripped() {
        String input = "We need to fix the front porch stairs before winter.";
        // 4 consecutive identical words: "the front porch stairs"
        String outputVerbatim = "{\"intent\":\"plan\",\"topics\":[\"home\"],\"summary\":\"Repair the front porch stairs soon.\"}";

        SummaryGuard.GuardResult res = SummaryGuard.check(outputVerbatim, input.toCharArray());
        assertTrue(res.isOk);
        assertEquals("", res.summary.summary);
        assertEquals("verbatim", res.summary.strippedReason);
    }

    @Test
    public void quotesAndUrlsAndEmailsAreStripped() {
        String input = "Check the document at https://example.com/doc or email test@example.com";

        // Quote
        String outputQuote = "{\"intent\":\"tell\",\"topics\":[\"work_task\"],\"summary\":\"He said \\\"important update\\\" today.\"}";
        SummaryGuard.GuardResult resQuote = SummaryGuard.check(outputQuote, input.toCharArray());
        assertTrue(resQuote.isOk);
        assertEquals("", resQuote.summary.summary);
        assertEquals("quote", resQuote.summary.strippedReason);

        // URL
        String outputUrl = "{\"intent\":\"tell\",\"topics\":[\"work_task\"],\"summary\":\"Review the link at example.com now.\"}";
        SummaryGuard.GuardResult resUrl = SummaryGuard.check(outputUrl, input.toCharArray());
        assertTrue(resUrl.isOk);
        assertEquals("", resUrl.summary.summary);
        assertEquals("url", resUrl.summary.strippedReason);

        // Email
        String outputEmail = "{\"intent\":\"tell\",\"topics\":[\"work_task\"],\"summary\":\"Send notes to alice@example.org today.\"}";
        SummaryGuard.GuardResult resEmail = SummaryGuard.check(outputEmail, input.toCharArray());
        assertTrue(resEmail.isOk);
        assertEquals("", resEmail.summary.summary);
        assertEquals("email", resEmail.summary.strippedReason);
    }

    @Test
    public void tooLongSummaryIsStripped() {
        String input = "Short text.";
        // More than 20 words
        String longWords = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.";
        String output = "{\"intent\":\"tell\",\"topics\":[\"other\"],\"summary\":\"" + longWords + "\"}";

        SummaryGuard.GuardResult res = SummaryGuard.check(output, input.toCharArray());
        assertTrue(res.isOk);
        assertEquals("", res.summary.summary);
        assertEquals("too_long", res.summary.strippedReason);
    }

    @Test
    public void inputCharsUntouchedByGuard() {
        char[] input = "Original input array".toCharArray();
        char[] copy = Arrays.copyOf(input, input.length);

        String output = "{\"intent\":\"plan\",\"topics\":[\"planning\"],\"summary\":\"Safe general summary.\"}";
        SummaryGuard.check(output, input);

        assertArrayEquals(copy, input);
    }
}
