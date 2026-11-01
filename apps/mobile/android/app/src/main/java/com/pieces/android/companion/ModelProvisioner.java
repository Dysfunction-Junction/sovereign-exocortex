package com.pieces.android.companion;

import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.security.*;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** Local staged import only. The lock also serializes cleanup and load verification. */
public final class ModelProvisioner {
    public enum Result { OK, PIN_REQUIRED, ALREADY_RUNNING, ENGINE_ACTIVE, MISSING,
        UNSAFE_PATH, SIZE_MISMATCH, HASH_MISMATCH, NO_SPACE, IO_ERROR }
    static final int CHUNK_BYTES = 1024 * 1024;
    private static final ReentrantLock LOCK = new ReentrantLock();
    private final File filesDir, stagingDir;
    private final ModelSpec spec;
    private final BooleanSupplier engineInitialized;
    // Process-local: a new process (including reboot/upgrade) must rehash.
    private long verifiedMtime = -1;

    public ModelProvisioner(File filesDir, File stagingDir, BooleanSupplier engineInitialized) {
        this(filesDir, stagingDir, new ModelSpec(), engineInitialized);
    }
    public ModelProvisioner(File filesDir, File stagingDir, ModelSpec spec, BooleanSupplier initialized) {
        this.filesDir = filesDir; this.stagingDir = stagingDir;
        this.spec = spec; this.engineInitialized = initialized;
    }
    public File modelFile() { return new File(new File(filesDir, "models"), spec.internalName()); }
    private File manifest() { return new File(modelFile().getPath() + ".json"); }
    private File models() throws IOException {
        File dir = new File(filesDir, "models");
        Files.createDirectories(dir.toPath());
        if (!safe(dir)) throw new IOException("UNSAFE_PATH");
        return dir;
    }
    private static boolean safe(File f) throws IOException {
        return f.getCanonicalPath().equals(f.getAbsolutePath());
    }
    private interface Operation { Result run() throws Exception; }
    private Result locked(Operation op) {
        if (!LOCK.tryLock()) return Result.ALREADY_RUNNING;
        try (RandomAccessFile lock = new RandomAccessFile(new File(models(), ".provision.lock"), "rw");
             FileLock held = lock.getChannel().tryLock()) {
            return held == null ? Result.ALREADY_RUNNING : op.run();
        } catch (OverlappingFileLockException e) { return Result.ALREADY_RUNNING; }
        catch (Exception e) { return Result.IO_ERROR; }
        finally { LOCK.unlock(); }
    }
    /** Invoke at startup, before any engine exists. Persistent file locks survive process death safely. */
    public Result cleanup() {
        if (!spec.valid()) return Result.PIN_REQUIRED;
        return locked(() -> {
            if (engineInitialized.getAsBoolean()) return Result.ENGINE_ACTIVE;
            cleanupLocked();
            return Result.OK;
        });
    }
    private void cleanupLocked() throws IOException {
        File[] entries = models().listFiles();
        if (entries == null) throw new IOException("IO_ERROR");
        for (File f : entries) {
            String n = f.getName();
            if (n.startsWith(".tmp-") || (n.endsWith(".litertlm") || n.endsWith(".litertlm.json"))
                    && !n.equals(spec.internalName()) && !n.equals(spec.internalName() + ".json")) {
                Files.delete(f.toPath());
            }
        }
    }
    public Result provision() {
        if (!spec.valid()) return Result.PIN_REQUIRED;
        return locked(() -> {
            if (engineInitialized.getAsBoolean()) return Result.ENGINE_ACTIVE;
            cleanupLocked();
            File staged = new File(stagingDir, ModelSpec.FILE);
            if (!safe(staged)) return Result.UNSAFE_PATH;
            if (!Files.isRegularFile(staged.toPath(), LinkOption.NOFOLLOW_LINKS)) return Result.MISSING;
            if (staged.length() != spec.size) return Result.SIZE_MISMATCH;
            if (filesDir.getUsableSpace() < Math.ceil(spec.size * 1.15) + 256L * CHUNK_BYTES)
                return Result.NO_SPACE;
            File tmp = new File(models(), ".tmp-" + UUID.randomUUID());
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long size = 0;
                byte[] chunk = new byte[CHUNK_BYTES];
                try (InputStream in = Files.newInputStream(staged.toPath(), LinkOption.NOFOLLOW_LINKS);
                     FileOutputStream out = new FileOutputStream(tmp)) {
                    int count;
                    while ((count = in.read(chunk)) != -1) {
                        size += count;
                        if (size > spec.size) return Result.SIZE_MISMATCH;
                        out.write(chunk, 0, count);
                        digest.update(chunk, 0, count);
                    }
                    out.getFD().sync();
                }
                if (size != spec.size) return Result.SIZE_MISMATCH;
                if (!hex(digest.digest()).equals(spec.sha256)) return Result.HASH_MISMATCH;
                Files.move(tmp.toPath(), modelFile().toPath(), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                if (!modelFile().setReadOnly()) throw new IOException("IO_ERROR");
                // No sidecar means no load if purge fails.
                Files.deleteIfExists(manifest().toPath());
                Files.delete(staged.toPath());
                if (staged.exists()) throw new IOException("IO_ERROR");
                writeManifest();
                verifiedMtime = -1;
                return Result.OK;
            } finally { Files.deleteIfExists(tmp.toPath()); }
        });
    }
    private void writeManifest() throws Exception {
        JSONObject json = new JSONObject().put("sha256", spec.sha256).put("size", spec.size)
                .put("mtime", modelFile().lastModified());
        File tmp = new File(models(), ".tmp-" + UUID.randomUUID());
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            Files.move(tmp.toPath(), manifest().toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(tmp.toPath()); }
    }
    public boolean verifyForLoad() {
        if (!spec.valid()) return false;
        return locked(() -> {
            if (!engineInitialized.getAsBoolean()) cleanupLocked();
            File model = modelFile();
            if (!safe(model) || !safe(manifest()) || !model.isFile() || !manifest().isFile()
                    || manifest().length() > 4096 || model.length() != spec.size) return Result.SIZE_MISMATCH;
            JSONObject json = new JSONObject(new String(Files.readAllBytes(manifest().toPath()),
                    java.nio.charset.StandardCharsets.UTF_8));
            if (!spec.sha256.equals(json.getString("sha256")) || json.getLong("size") != spec.size
                    || json.getLong("mtime") != model.lastModified()) return Result.HASH_MISMATCH;
            if (verifiedMtime != model.lastModified()) {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] chunk = new byte[CHUNK_BYTES];
                try (InputStream in = Files.newInputStream(model.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                    int count;
                    while ((count = in.read(chunk)) != -1) digest.update(chunk, 0, count);
                }
                if (!hex(digest.digest()).equals(spec.sha256)) return Result.HASH_MISMATCH;
                verifiedMtime = model.lastModified();
            }
            return Result.OK;
        }) == Result.OK;
    }
    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
}
