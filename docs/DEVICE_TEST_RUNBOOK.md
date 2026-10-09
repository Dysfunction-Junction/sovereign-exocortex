# Device test: biometric approval end to end

Goal: surface one harmless test proposal on the PC, approve it on the phone with your fingerprint, and see the
decision reach the triad. Nothing is executed: the proposal's action is the read-only `diagnostic_probe`, and no
auto-executor is attached.

Known to work before you start (tested in this repo): the APK builds, the daemon/registry/triad code paths pass
their tests, and the registry nonce flow was run live. NOT yet run on hardware: the BiometricPrompt, the Keystore
key, and the Android attestation chain. Expect to debug those; section 6 lists what each failure means.

## 0. Prerequisites
- Phone on USB/wireless debugging (`adb devices` shows it). The installed app is a debuggable build, so a debug APK
  from this PC should install as an update. If Android reports `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the signing
  keys differ; uninstalling would erase the app's data, so decide that yourself.
- A fingerprint (or face) enrolled in Android settings. Approval keys use BIOMETRIC_STRONG only; a PIN will not work.
- Repos next to this one in `C:\Users\micha\projects`: `autonomous-triad`, `registry-app` (the others are optional).

## 1. Build and install the app (PowerShell)
```
cd C:\Users\micha\projects\sovereign-exocortex\apps\mobile
pnpm build
npx cap sync android
cd android
.\gradlew assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```
`cap sync` regenerates the Gradle plugin paths for this pnpm layout and links the push plugin. Without it the build fails.

## 2. Start the PC side (two PowerShell windows, same variables in both)
Use your own random values. They never leave this PC.
```
$env:GATEWAY_JWT_SECRET   = "<32+ random characters>"
$env:GATEWAY_ENROLL_TOKEN = "<random>"
$env:TRIAD_SERVER_TOKEN   = "<random>"
$env:HOME_PROXY_BASE_URL  = "http://127.0.0.1:8787"   # required to start; unused by this test
$env:HOME_PROXY_TOKEN     = "unused"                   # required to start; unused by this test
$env:SHADOW               = "0"                        # without this /network/approve answers 423
cd C:\Users\micha\projects\sovereign-exocortex\apps\daemon
```
- Window 1: `npx tsx src/mishmash-up.ts` (starts the triad on :8789 and registry-app on :39403 and the other nodes).
- Window 2: `pnpm start` (gateway on :8788).
- Check: `curl http://127.0.0.1:8788/mobile/health` returns 200.

## 3. Enroll the phone (window 2's variables, a third window is fine)
```
pnpm enroll -- "My S26"
```
Copy the token it prints. It also registers the phone in the v3 database with minimum scopes.

## 4. Connect the phone to the gateway
```
adb reverse tcp:8788 tcp:8788
```
In the app: Setup -> the "Plan B" (remote gateway) card -> Gateway URL `http://127.0.0.1:8788`, Device Token = the JWT
from step 3 -> Test & Save Connection. (It may say the proxy is unreachable because PiecesOS is not part of this
test; the approval flow does not need it.)

Then, in the same Setup screen, "Approval key (biometric)": paste the `GATEWAY_ENROLL_TOKEN` value -> Register approval key.
You are asked for your fingerprint once. Success message: "Approval key registered".

## 5. Approve something
1. In the daemon window: `pnpm surface-test` -> prints `Surfaced test proposal devtest_...`.
2. Keep the app open in the foreground. Within ~10 seconds the approval modal appears (the poller runs every 10 s).
3. Tap Approve -> fingerprint prompt -> modal closes.
4. Verify on the PC (any window): the proposal is APPROVED and a `wanted` tap label exists. With the CLI:
   `npx tsx -e "import('./src/db-host.js').then(m=>{const db=m.getDatabase();const p=db.listProposalsByState(['APPROVED','SURFACED']);console.log(p.map(x=>x.proposal_id+' '+x.state));console.log(db.getShadowLabels().map(l=>l.proposal_id+' '+l.label+' '+l.actual))})"`
5. Run `pnpm surface-test` again and tap Dismiss instead: you are asked for a fingerprint, and the proposal ends REJECTED.

## 6. If something fails
| What you see | Meaning | Fix |
|---|---|---|
| Register approval key: "key attestation rejected: ..." | The daemon rejected the Android attestation chain (software-only key, wrong challenge, or the pinned roots are stale) | Read the reason. Do NOT bypass on a real phone. For an emulator only: `$env:EXOCORTEX_ALLOW_UNATTESTED_KEYS = "1"` before `pnpm start` |
| Register approval key: "Strong biometrics are not set up" | No BIOMETRIC_STRONG enrolled | Enroll a fingerprint/face in Android settings |
| Approve returns 423 "shadow mode" | `SHADOW` is not `0` in the daemon window | Set it and restart `pnpm start` |
| Approve returns 428 | No approval key registered for this device | Repeat the key registration in Setup |
| Approve returns 422 "attestation ... invalid" | Signature does not match the registered key (e.g. key was regenerated) | Register the key again |
| Approve returns 401 from the triad | `TRIAD_SERVER_TOKEN` differs between the daemon and the mishmash-up window | Same value in both windows, restart both |
| Modal never appears | Proposal not SURFACED/STAGED, expired (10 min), registry-app not running on :39403, or the app is in the background | Run `pnpm surface-test` again; check window 1 output |
| `KEY_INVALIDATED` | Fingerprints changed after the key was made | Register the key again |
| Prompt appears but does nothing / app crashes | Native BiometricPrompt issue (never run before) | `adb logcat -s Capacitor ApprovalKey AndroidRuntime` and send me the output |

## 7. Clean up
- Stop both daemon windows (Ctrl+C). Unset the variables by closing the windows.
- `adb reverse --remove tcp:8788`.
- The test proposal and labels stay in `%LOCALAPPDATA%\exocortex.db`. They are harmless.
