# Android capture handoff — 2026-10-29

- Main was at `0ffa7c1`; an existing untracked `.claude/` directory was left alone.
- The user chose Gemma 3 1B 4-bit for the first A5 evaluation and chose to keep Messenger, Discord, social apps and the dialer excluded. See the sensitive capture design for the recorded decisions and preliminary phone results.
- The daemon received mic and place windows. Places reported `wifi_connected`. Earlier mic windows had `unknown` pocket-gate skips; later windows had valid samples. The user confirmed the phone was pocketed for 10–15 minutes; audio diagnostics showed a five-second recording at 15:43:49 and the 15:40–15:45 window had zero pocket skips. S3-3 failed. Investigate the gate and sensor behavior before changing it; background capture with another app on top remains unverified.
- A5 is still a stub. Implement its privacy controls, storage, audit and typing rhythm, then evaluate the selected model and battery/quality before enabling it. No implementation, build, tests, PR or merge was completed in this session.
- Do not uninstall or clear app data, change phone permissions or switches, or commit phone backups. Preserve the user's untracked files.
