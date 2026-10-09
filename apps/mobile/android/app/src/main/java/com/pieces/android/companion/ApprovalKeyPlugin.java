package com.pieces.android.companion;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.cert.Certificate;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * Device-bound approval signing. An EC P-256 key lives in the Android Keystore and may only sign after a
 * fresh strong-biometric authentication (per-use, via BiometricPrompt + CryptoObject). The daemon verifies
 * the signature against the public key registered for this device, so approvals cannot be forged by anyone
 * who merely holds the app, the JWT, or the unlocked phone without a matching biometric.
 *
 * The key is invalidated when biometrics are re-enrolled; the user then has to register a new key.
 */
@CapacitorPlugin(name = "ApprovalKey")
public class ApprovalKeyPlugin extends Plugin {

    static final String KEY_ALIAS = "exocortex_approval_key_v1";
    static final String ANDROID_KEYSTORE = "AndroidKeyStore";

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = BiometricManager.from(getContext())
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        JSObject ret = new JSObject();
        ret.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("status", status);
        call.resolve(ret);
    }

    /**
     * With {@code attestationChallenge}: DELETES any existing key and regenerates it with that challenge baked into
     * the Keystore attestation certificate (the daemon verifies the chain and the challenge). Without it: creates the
     * key only if absent. Returns the SPKI public key (base64, no wrap) and the attestation certificate chain
     * (base64 DER, leaf first).
     */
    @PluginMethod
    public void ensureKey(PluginCall call) {
        try {
            String challenge = call.getString("attestationChallenge");
            KeyStore ks = loadKeyStore();
            if (challenge != null && !challenge.isEmpty()) {
                if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
                generateKey(challenge.getBytes(StandardCharsets.UTF_8));
            } else if (!ks.containsAlias(KEY_ALIAS)) {
                generateKey(null);
            }
            PublicKey pub = ks.getCertificate(KEY_ALIAS).getPublicKey();
            JSArray chain = new JSArray();
            Certificate[] certs = ks.getCertificateChain(KEY_ALIAS);
            if (certs != null) {
                for (Certificate c : certs) {
                    chain.put(Base64.encodeToString(c.getEncoded(), Base64.NO_WRAP));
                }
            }
            JSObject ret = new JSObject();
            ret.put("publicKeyB64", Base64.encodeToString(pub.getEncoded(), Base64.NO_WRAP));
            ret.put("attestationChain", chain);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not create approval key: " + e.getMessage(), "KEY_ERROR");
        }
    }

    /** Deletes the key (used after biometric re-enrollment invalidates it). */
    @PluginMethod
    public void resetKey(PluginCall call) {
        try {
            KeyStore ks = loadKeyStore();
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not reset approval key: " + e.getMessage(), "KEY_ERROR");
        }
    }

    /** Prompts for a strong biometric, then signs the UTF-8 message. Returns a DER ECDSA signature (base64). */
    @PluginMethod
    public void sign(final PluginCall call) {
        final String message = call.getString("message");
        if (message == null || message.isEmpty()) {
            call.reject("message is required", "BAD_REQUEST");
            return;
        }
        final String title = call.getString("title", "Confirm approval");
        final String subtitle = call.getString("subtitle", "Authenticate to approve this action");

        final Signature signature;
        try {
            KeyStore ks = loadKeyStore();
            PrivateKey key = (PrivateKey) ks.getKey(KEY_ALIAS, null);
            if (key == null) {
                call.reject("No approval key registered", "NO_KEY");
                return;
            }
            signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key);
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("Biometrics changed; register a new approval key", "KEY_INVALIDATED");
            return;
        } catch (Exception e) {
            call.reject("Could not prepare signature: " + e.getMessage(), "KEY_ERROR");
            return;
        }

        if (!(getActivity() instanceof FragmentActivity)) {
            call.reject("No activity available", "NO_ACTIVITY");
            return;
        }
        final FragmentActivity activity = (FragmentActivity) getActivity();

        activity.runOnUiThread(() -> {
            BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        Signature s = result.getCryptoObject().getSignature();
                        s.update(message.getBytes(StandardCharsets.UTF_8));
                        JSObject ret = new JSObject();
                        ret.put("signatureB64", Base64.encodeToString(s.sign(), Base64.NO_WRAP));
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("Signing failed: " + e.getMessage(), "SIGN_ERROR");
                    }
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    boolean cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED
                        || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                        || errorCode == BiometricPrompt.ERROR_CANCELED;
                    call.reject(errString.toString(), cancelled ? "CANCELLED" : "AUTH_ERROR");
                }
                // onAuthenticationFailed: a non-matching attempt; the prompt stays open for a retry.
            };

            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .setConfirmationRequired(true)
                .build();

            new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), callback)
                .authenticate(info, new BiometricPrompt.CryptoObject(signature));
        });
    }

    private KeyStore loadKeyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        return ks;
    }

    private void generateKey(byte[] attestationChallenge) throws Exception {
        try {
            generateKey(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P, attestationChallenge);
        } catch (StrongBoxUnavailableException e) {
            generateKey(false, attestationChallenge);
        }
    }

    private void generateKey(boolean strongBox, byte[] attestationChallenge) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // timeout 0 = authentication required for every signature
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(-1);
        }
        if (attestationChallenge != null) {
            spec.setAttestationChallenge(attestationChallenge);
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            spec.setIsStrongBoxBacked(true);
        }
        KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE);
        kpg.initialize(spec.build());
        kpg.generateKeyPair();
    }
}
