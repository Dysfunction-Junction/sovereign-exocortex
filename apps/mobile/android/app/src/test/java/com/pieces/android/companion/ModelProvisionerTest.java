package com.pieces.android.companion;

import org.junit.*;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.security.MessageDigest;

public class ModelProvisionerTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();
    private File files, staging, source;
    private byte[] bytes;
    private ModelSpec spec;
    private ModelProvisioner provisioner;
    @Before public void setup() throws Exception {
        files = temp.newFolder("internal"); staging = temp.newFolder("staging");
        bytes = new byte[ModelProvisioner.CHUNK_BYTES * 2 + 37];
        new java.util.Random(42).nextBytes(bytes);
        spec = new ModelSpec(bytes.length, ModelProvisioner.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        source = new File(staging, ModelSpec.FILE); Files.write(source.toPath(), bytes);
        provisioner = new ModelProvisioner(files, staging, spec, () -> false);
    }
    @After public void writable() { if (spec != null) provisioner.modelFile().setWritable(true); }
    @Test public void emptyProductionHashDisablesProvisioningAndLoading() {
        assertEquals(584417280L, ModelSpec.EXPECTED_SIZE);
        ModelSpec unpinned = new ModelSpec(ModelSpec.EXPECTED_SIZE, "");
        assertFalse(unpinned.valid());
        ModelProvisioner disabled = new ModelProvisioner(files, staging, unpinned, () -> false);
        assertEquals(ModelProvisioner.Result.PIN_REQUIRED, disabled.provision());
        assertFalse(disabled.verifyForLoad());
        assertTrue(source.exists());
        assertFalse(new File(files, "models").exists());
    }
    @Test public void invalidPinsFailClosedAndSyntheticPinIsValid() {
        assertTrue(spec.valid());
        for (String pin : new String[] { null, "", "placeholder", "0".repeat(64), "g".repeat(64) })
            assertFalse(new ModelSpec(bytes.length, pin).valid());
        assertFalse(new ModelSpec(0, spec.sha256).valid());
        if (ModelSpec.EXPECTED_SHA256.isEmpty()) assertFalse(new ModelSpec().valid());
        else assertTrue(new ModelSpec().valid());
    }
    @Test public void streamsHashesCommitsPurgesAndVerifiesAfterRestart() throws Exception {
        assertEquals(ModelProvisioner.Result.OK, provisioner.provision());
        assertFalse(source.exists()); assertArrayEquals(bytes, Files.readAllBytes(provisioner.modelFile().toPath()));
        assertTrue(provisioner.verifyForLoad());
        assertTrue(new ModelProvisioner(files, staging, spec, () -> false).verifyForLoad());
        assertEquals(0, files.toPath().resolve("models").toFile().listFiles((d,n) -> n.startsWith(".tmp-")).length);
    }
    @Test public void rejectsFourTamperVariants() throws Exception {
        Files.write(source.toPath(), new byte[bytes.length - 1]);
        assertEquals(ModelProvisioner.Result.SIZE_MISMATCH, provisioner.provision());
        Files.write(source.toPath(), new byte[bytes.length + 1]);
        assertEquals(ModelProvisioner.Result.SIZE_MISMATCH, provisioner.provision());
        bytes[10] ^= 1; Files.write(source.toPath(), bytes);
        assertEquals(ModelProvisioner.Result.HASH_MISMATCH, provisioner.provision());
        bytes[10] ^= 1; bytes[bytes.length - 1] ^= 1; Files.write(source.toPath(), bytes);
        assertEquals(ModelProvisioner.Result.HASH_MISMATCH, provisioner.provision());
        assertTrue(source.exists()); assertFalse(provisioner.modelFile().exists());
    }
    @Test public void sidecarAndInternalTamperingRefuseLoad() throws Exception {
        assertEquals(ModelProvisioner.Result.OK, provisioner.provision());
        provisioner.modelFile().setWritable(true);
        long mtime = provisioner.modelFile().lastModified();
        bytes[0] ^= 1; Files.write(provisioner.modelFile().toPath(), bytes);
        provisioner.modelFile().setLastModified(mtime);
        assertFalse(new ModelProvisioner(files, staging, spec, () -> false).verifyForLoad());
        Files.delete(new File(provisioner.modelFile().getPath() + ".json").toPath());
        assertFalse(provisioner.verifyForLoad());
    }
    @Test public void rejectsActiveEngineAndConcurrentImporter() throws Exception {
        assertEquals(ModelProvisioner.Result.ENGINE_ACTIVE,
                new ModelProvisioner(files, staging, spec, () -> true).provision());
        File dir = new File(files, "models"); dir.mkdirs();
        try (RandomAccessFile f = new RandomAccessFile(new File(dir, ".provision.lock"), "rw");
             FileLock held = f.getChannel().lock()) {
            assertEquals(ModelProvisioner.Result.ALREADY_RUNNING, provisioner.provision());
        }
        assertTrue(source.exists());
    }
    @Test public void cleansStaleArtifactsAndRejectsUnpinnedModel() throws Exception {
        File dir = new File(files, "models"); dir.mkdirs();
        Files.write(new File(dir, ".tmp-abandoned").toPath(), new byte[0]);
        Files.write(new File(dir, "old.litertlm").toPath(), new byte[0]);
        assertEquals(ModelProvisioner.Result.OK, provisioner.cleanup());
        assertFalse(new File(dir, ".tmp-abandoned").exists());
        assertFalse(new File(dir, "old.litertlm").exists());
        assertEquals(ModelProvisioner.Result.PIN_REQUIRED,
                new ModelProvisioner(files, staging, new ModelSpec(0, ""), () -> false).provision());
    }
    @Test public void nonCanonicalStagingPathRejected() {
        ModelProvisioner unsafe = new ModelProvisioner(files, new File(staging, "../staging"), spec, () -> false);
        assertEquals(ModelProvisioner.Result.UNSAFE_PATH, unsafe.provision());
        assertTrue(source.exists());
    }
}
