# Push (FCM) setup for proposal delivery

Proposals reach the phone two ways. Polling needs no setup. Push is an optional wake-up that makes a new proposal
show up immediately instead of within ~10 s (and while the app is open only; see "Limits").

- **Polling (always on):** while the app is foregrounded it calls `GET /v3/proposals/pending` every ~10 s
  (exponential backoff up to 2 min on errors, stops when backgrounded). See `src/lib/proposalPoller.ts`.
- **Push (optional):** the daemon sends an FCM *data* message `{type:"proposal", proposal_id}` (no nonce, no summary).
  The app only uses it as a trigger to poll; the proposal itself always comes from the authenticated daemon call.

## Phone side

1. Create a Firebase project and add an Android app with package `com.pieces.android.companion`.
2. Download `google-services.json` to `apps/mobile/android/app/google-services.json`.
   Do **not** commit it (it is deliberately absent from git). `app/build.gradle` already applies the
   `google-services` plugin only when that file exists, so builds without it still work and push silently stays off.
3. Link the Android plugin: from `apps/mobile` run `npx cap sync android` (this regenerates
   `android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle` to include
   `@capacitor/push-notifications`). The checked-in copies were not regenerated here, so until you sync, the
   native push module is not part of the Gradle build and the JS side just no-ops.
   Note: in this pnpm layout the generated `../../../node_modules` path may need fixing locally (see
   `docs/AUDIT_FOLLOWUP_PLAN_2026-10-09.md`).
4. On Android 13+ the app asks for the `POST_NOTIFICATIONS` permission (declared in the manifest) on first launch.
   After FCM registration the token is POSTed to `/v3/devices/push-token` as `{token, platform:"fcm"}`;
   a failed upload (not enrolled, PC offline) is retried every time the app returns to the foreground.

## Daemon side

Set these in the daemon's environment:

- `FCM_PROJECT_ID`: the Firebase project id.
- `GOOGLE_APPLICATION_CREDENTIALS`: path to a service-account JSON with the *Firebase Cloud Messaging API (V1)*
  sender role.

Without them the daemon cannot send pushes; the phone keeps working via polling.

## What cannot be tested without them

- Token registration, permission prompt and the FCM round trip need a real device (or emulator with Play Services),
  `google-services.json` and the daemon credentials. Unit tests mock `@capacitor/push-notifications`.
- Background delivery: tapping a notification opens the app, which polls on resume. A *data-only* message does not
  show a system notification by itself while the app is backgrounded; making it visible needs a `notification`
  block on the daemon side (not part of the agreed `{type, proposal_id}` payload) or a native
  `FirebaseMessagingService`. Until then, background wake-up is best-effort and polling on resume is the guarantee.
- Key attestation (`attestation_chain`) can only be produced by a hardware-backed Android Keystore; emulators yield
  software-only keys that the daemon rejects unless `EXOCORTEX_ALLOW_UNATTESTED_KEYS=1`.
