package com.pieces.android.companion;

import android.content.*;
import android.os.*;
import android.util.Log;
import com.google.mlkit.genai.prompt.*;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;
import com.google.mlkit.genai.speechrecognition.*;
import com.google.mlkit.genai.common.audio.AudioSource;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import kotlin.Unit;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import kotlinx.coroutines.flow.FlowCollector;

/** Disposable, shell-only synthetic spike. Never reads the microphone or accessibility text. */
public final class SpeechApiSpike {
    private static final String TAG = "SpeechApiSpike";
    private static final AtomicBoolean registered = new AtomicBoolean();
    private static final AtomicBoolean used = new AtomicBoolean();

    public static void register(Context service) {
        if (!registered.compareAndSet(false, true)) return;
        Context app = service.getApplicationContext();
        app.registerReceiver(new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!used.compareAndSet(false, true)) return;
                app.unregisterReceiver(this);
                new Thread(() -> {
                    run(app, "prompt", () -> prompt());
                    run(app, "speech_advanced", () -> speech());
                }, "synthetic-api-spike").start();
            }
        }, new IntentFilter("com.pieces.android.companion.SYNTHETIC_SPIKE"),
            "android.permission.DUMP", null, Context.RECEIVER_EXPORTED);
        Log.i(TAG, "READY synthetic_only one_shot");
    }

    private interface Operation { String call() throws Exception; }
    private static long charge(Context context) {
        BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        return battery.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER);
    }
    private static void run(Context context, String api, Operation operation) {
        long start = SystemClock.elapsedRealtime(), before = charge(context);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        Future<String> task = worker.submit(() -> operation.call());
        String result;
        try { result = task.get(45, TimeUnit.SECONDS); }
        catch (Exception e) {
            task.cancel(true);
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            // Every request is fixed synthetic input. No model output or real user input is logged.
            result = root.getClass().getName() + ":" + root.getMessage();
        } finally { worker.shutdownNow(); }
        Log.i(TAG, api + " result=" + result + " elapsed_ms="
            + (SystemClock.elapsedRealtime() - start) + " charge_before_uAh=" + before
            + " charge_after_uAh=" + charge(context));
    }

    private static String prompt() throws Exception {
        GenerativeModel client = Generation.INSTANCE.getClient();
        try {
            GenerativeModelFutures model = GenerativeModelFutures.from(client);
            int status = model.checkStatus().get(15, TimeUnit.SECONDS);
            Log.i(TAG, "prompt status=" + status);
            GenerateContentResponse response = model.generateContent(new GenerateContentRequest.Builder(
                new TextPart("Summarize briefly: A person plans a walk after lunch.")).build())
                .get(25, TimeUnit.SECONDS);
            return "SUCCESS candidates=" + response.getCandidates().size();
        } finally { client.close(); }
    }

    private static String speech() throws Exception {
        SpeechRecognizerOptions.Builder options = new SpeechRecognizerOptions.Builder();
        options.setLocale(Locale.US);
        options.setPreferredMode(SpeechRecognizerOptions.Mode.MODE_ADVANCED);
        SpeechRecognizer client = SpeechRecognition.INSTANCE.getClient(options.build());
        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        byte[] pcm = new byte[3200]; // 100 ms of generated silence, ten chunks; no real audio.
        Thread writer = new Thread(() -> {
            try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                for (int i = 0; i < 10; i++) { out.write(pcm); Thread.sleep(100); }
            } catch (Exception ignored) {
            } finally { Arrays.fill(pcm, (byte) 0); }
        }, "synthetic-pcm");
        final String[] outcome = {"COMPLETED_WITHOUT_FINAL_TEXT"};
        try {
            int status = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                (scope, continuation) -> client.checkStatus(continuation));
            Log.i(TAG, "speech_advanced status=" + status);
            SpeechRecognizerRequest.Builder request = new SpeechRecognizerRequest.Builder();
            request.setAudioSource(AudioSource.fromPfd(pipe[0]));
            writer.start();
            BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, continuation) ->
                client.startRecognition(request.build()).collect(new FlowCollector<SpeechRecognizerResponse>() {
                    @Override public Object emit(SpeechRecognizerResponse response,
                        kotlin.coroutines.Continuation<? super Unit> next) {
                        if (response instanceof SpeechRecognizerResponse.ErrorResponse)
                            throw new RuntimeException(((SpeechRecognizerResponse.ErrorResponse) response).getE());
                        if (response instanceof SpeechRecognizerResponse.FinalTextResponse)
                            outcome[0] = "SUCCESS_FINAL_RESPONSE_OUTPUT_DISCARDED";
                        return Unit.INSTANCE;
                    }
                }, continuation));
            return outcome[0];
        } finally {
            writer.interrupt();
            pipe[0].close(); pipe[1].close();
            writer.join(1000);
            Arrays.fill(pcm, (byte) 0);
            client.close();
        }
    }
}
