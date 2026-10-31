package com.pieces.android.companion;

import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Scans the actual Java/Kotlin pipeline and nested compiled classes, not empty legacy paths. */
public class NoNetworkInvariantTest {
    private static final Set<String> PIPELINE = new HashSet<>(Arrays.asList(
            "LlmBackend", "LlmException", "LiteRtBridge", "LiteRtSummarizer", "ModelSpec", "ModelProvisioner"));
    private static final Pattern NETWORK = Pattern.compile(
            "java[./]net|javax[./]net|okhttp|retrofit|(?:io[./])?ktor|HttpURLConnection|"
            + "\\bURL\\b|Socket|WebView|DownloadManager|java[./]lang[./]reflect|"
            + "Class[./]forName|ProcessBuilder|java[./]lang[./]Runtime", Pattern.CASE_INSENSITIVE);
    private static boolean pipeline(Path p) {
        String n = p.getFileName().toString().split("[.$]", 2)[0];
        String path = p.toString().replace('\\', '/');
        return PIPELINE.contains(n) || path.contains("/typedtext/llm/") || path.contains("/typedtext/provision/");
    }
    private static int scan(Path root, String extension) throws Exception {
        assertTrue("Missing scan root: " + root, Files.isDirectory(root));
        int count = 0;
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : (Iterable<Path>) files.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(extension)).filter(NoNetworkInvariantTest::pipeline)::iterator) {
                String contents = new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1);
                assertFalse("Network reference in " + file, NETWORK.matcher(contents).find());
                count++;
            }
        }
        return count;
    }
    @Test public void pipelineSourceAndBytecodeHaveNoNetworkReferences() throws Exception {
        assertEquals(5, scan(Paths.get("src/main/java"), ".java"));
        assertEquals(1, scan(Paths.get("src/main/kotlin"), ".kt"));
        assertTrue(scan(Paths.get("build/intermediates/javac/debug/compileDebugJavaWithJavac/classes"), ".class") >= 5);
        assertTrue(scan(Paths.get("build/tmp/kotlin-classes/debug"), ".class") >= 1);
    }
    @Test public void scannerDetectsForbiddenReferences() {
        for (String value : Arrays.asList("java.net.URL", "java/net/Socket", "okhttp3/OkHttpClient",
                "android/webkit/WebView", "android/app/DownloadManager", "retrofit2/Retrofit", "io/ktor/client"))
            assertTrue(value, NETWORK.matcher(value).find());
    }
    @Test public void bridgeIsBoundedAndOnlyShimReferencesLibrary() throws Exception {
        Path source = Paths.get("src/main/kotlin/com/pieces/android/companion/LiteRtBridge.kt");
        assertTrue(Files.readAllLines(source).size() <= 80);
        try (Stream<Path> files = Files.walk(Paths.get("src/main"))) {
            for (Path file : (Iterable<Path>) files.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".java") || p.toString().endsWith(".kt"))::iterator) {
                if (!file.equals(source)) assertFalse("Library escaped shim: " + file,
                        new String(Files.readAllBytes(file), StandardCharsets.UTF_8).contains("com.google.ai.edge.litertlm"));
            }
        }
    }
}
