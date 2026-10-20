# Sovereign Exocortex — Operator Manual & Architectural Field Guide

> **Version:** 1.0.0 (Living Brain Synaptic Edition)  
> **Status:** Local-First, Shadow-First, Hardware-Attested Autonomous System  
> **Repository:** `sovereign-exocortex`

---

## Table of Contents
1. [System Architecture & Core Philosophy](#1-system-architecture--core-philosophy)
2. [Workstation Node & 3D Living Brain](#2-workstation-node--3d-living-brain)
3. [Telemetry Pipelines & Data Ingestion ("What Feeds What")](#3-telemetry-pipelines--data-ingestion-what-feeds-what)
4. [The Cognitive Core & Pre-Cognitive Engine](#4-the-cognitive-core--pre-cognitive-engine)
5. [Hardware Security, Cryptographic Keystores & Approvals](#5-hardware-security-cryptographic-keystores--approvals)
6. [Autonomous Multi-Agent Triad & Agent Mesh](#6-autonomous-multi-agent-triad--agent-mesh)
7. [Operator Runbook & Troubleshooting](#7-operator-runbook--troubleshooting)

---

## 1. System Architecture & Core Philosophy

Sovereign Exocortex is a private, local-first personal cognitive operating system. It observes continuous ambient signals across your workstation and mobile phone, maintains an associative Living World Model of your life and projects, anticipates your next useful intent, and stages proactive capabilities without interrupting you.

Nothing changes state or executes externally without your explicit, hardware-attested cryptographic biometric authorization.

```mermaid
flowchart TD
    subgraph SignalSources ["1. Multi-Device Telemetry Sources"]
        Phone["Android Companion<br/>(Accessibility, Notifications, SMS)"]
        PC["PC Workstation<br/>(PiecesOS Workstreams, IDE, CLI)"]
    end

    subgraph IngestionBus ["2. Transactional Transport & Storage"]
        Outbox["SQLite Outbox<br/>(Fail-Closed Local Queue)"]
        Gateway["Dual-Profile Gateway<br/>(LAN :8787 / Gateway :8788)"]
        EventLog[("Hash-Chained Event Log<br/>(SQLite WAL Source of Truth)")]
        Phone --> Outbox --> Gateway
        PC --> Gateway --> EventLog
    end

    subgraph WorldModelCore ["3. Living World Model & Cognitive Gate"]
        LivingGraph["Living Life Graph<br/>(Decaying & Spreading Activation)"]
        CognitiveGate{"Cognitive Mode Gate<br/>(Attentional State Filter)"}
        Neo4j[("Neo4j Desktop<br/>(Exocortex DBMS :7474/:7687)")]
        EventLog --> LivingGraph
        LivingGraph <--> Neo4j
        LivingGraph --> CognitiveGate
    end

    subgraph CognitionEngine ["4. Pre-Cognitive Engine & Policy Ranking"]
        ActiveInf["Active Inference Engine<br/>(Expected Free Energy Scoring)"]
        Anticipation["Anticipation Ring<br/>(p20 Touch-Dwell Quantile)"]
        CognitiveGate --> ActiveInf --> Anticipation
    end

    subgraph ActuationLayer ["5. Attestation & Execution"]
        GateMode{"Operating Mode"}
        ShadowLog[("Shadow Evaluation Log<br/>Precision@surface Tracker")]
        Biometric["Hardware BiometricPrompt<br/>(Android Keystore ECC)"]
        TriadMesh["Autonomous Triad & Agent Mesh MCP<br/>(Tool Execution & Playbooks)"]
        
        Anticipation --> GateMode
        GateMode -->|SHADOW=1 (Default)| ShadowLog
        GateMode -->|LIVE=1 (Elevated)| Biometric --> TriadMesh
    end

    subgraph VisualInterface ["6. Real-Time Command Center"]
        DesktopApp["Tauri Desktop Command Center<br/>(Hardware-Accelerated WebGL)"]
        SynapticEngine["Biomimetic Synaptic Engine<br/>(2-Hop Wave + Lateral Inhibition + Web Audio)"]
        LivingGraph --> DesktopApp --> SynapticEngine
    end
```

### The Core Invariants
1. **Shadow First (`SHADOW=1`):** Actuation is an earned capability granted per risk tier, never a build flag. The system logs what it *would* propose and evaluates how often it is correct.
2. **One Append-Only Event Log is Truth:** The life graph, beliefs, and caches are pure projections rebuilt from the hash-chained SQLite WAL event log.
3. **Deterministic Core:** Models propose; a typed, deterministic policy engine decides. No stochastic LLM sits in the approval gate.
4. **Capabilities, Not Trust:** Every device and agent holds scoped, revocable cryptographic grants.
5. **Zero Cloud Dependencies:** All database telemetry, vector stores, graph state, and daemon services reside on local hardware.

---

## 2. Workstation Node & 3D Living Brain

The desktop interface serves as the primary executive command center, providing real-time introspection into the daemon's internal state.

```
┌────────────────────────────────────────────────────────────────────────┐
│  ● Living Brain 3D  [HIGH_VELOCITY_EXECUTION]  ● Neo4j: 199 nodes      │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                      ( PERSON: Operator )                              │
│                         /           \                                  │
│                 [CONTRIBUTES_TO]  [OWNS]                               │
│                       /               \                                │
│        ( PROJECT: Exocortex )     ( DEVICE: Workstation )              │
│               |                                                        │
│         [DEPENDS_ON]                                                   │
│               |                                                        │
│        ( GOAL: Latency < 10ms )                                        │
│                                                                        │
│   Active Synaptic Circuit: Exocortex (1-hop: 12 · 2-hop: 38)           │
│   [🔊 Sound ON]  [Orbiting]  [Reset View]  [✕ Release Focus]           │
└────────────────────────────────────────────────────────────────────────┘
```

### Workstation Node Architecture
- **Host Binary:** Built with **Tauri v2** and **Rust 1.90** (`apps/desktop`).
- **Loopback IPC Bridge (`get_local_config`):** Tauri implements a native loopback TCP bridge that communicates with the daemon on `127.0.0.1:8788` over a raw socket. Because this operates at the native OS layer with no browser `Origin` header, it bypasses WebView2 CORS restrictions and pairs automatically on first boot.
- **Auto-Pairing:** Retrieves proxy bearer tokens and daemon JWTs automatically, storing them in Capacitor Preferences with zero manual QR scanning or proxy configuration.

### 3D Living Brain Mechanics
The canvas is rendered via `ForceGraph3D` and Three.js, mapping the active topology of the World Model across 8 entity taxonomies:

| Taxonomy | Color | Hex Code | Description |
|---|---|---|---|
| `PERSON` | Amber / Orange | `#fb923c` | Human collaborators and contacts |
| `PROJECT` | Electric Cyan | `#38bdf8` | Active code repositories and initiatives |
| `DEVICE` | Royal Purple | `#a78bfa` | Workstations, phones, micro-nodes |
| `GOAL` | Emerald Green | `#34d399` | Staged objectives and milestones |
| `ROUTINE` | Rose Pink | `#f472b6` | Automated habits and cron workflows |
| `CONTEXT_STATE` | Sun Gold | `#facc15` | Ephemeral attention and location states |
| `TOPIC` | Mint Teal | `#2dd4bf` | Semantic subject clusters |
| `DOC` | Slate Gray | `#94a3b8` | Documentation and reference assets |

### Biomimetic Synaptic Engine
Modeled on human cortical circuits to prevent visual "hairball" clutter:
1. **Action Potential Discharge:** Clicking any node fires an electrical spark. An impulse noise burst (2.6 kHz) and exponential sine pitch dive (340 Hz $\rightarrow$ 180 Hz) synthesize procedural audio via the Web Audio API.
2. **2-Hop Cascading Wave:**
   - **Hop 1 (Immediate):** Direct neighbors light up with thick myelinated beams (width 3.2, 6 fast directional particles), accompanied by a C5/E5 harmonic chime.
   - **Hop 2 (+110ms Delay):** Secondary branch leaves illuminate with purple harmonic conduits (width 1.8, 3 particles), followed by a delayed G5/C6 overtone ripple.
3. **Lateral Inhibition (Surround Suppression):** Unconnected background nodes instantly shrink to 1.2px, drop to 10% opacity, and desaturate into dark slate (`#1e293b`). Their connecting edges fade to near-invisible shadow traces (width 0.2, 0 particles).
4. **Hebbian Spring Tension (Dynamic Clustering):** D3 force distances dynamically tighten:
   - 1-hop distance shrinks to `24px` (tight orbit).
   - 2-hop distance shrinks to `42px`.
   - Distant nodes relax to `85px`.
   - The D3 simulation reheats, pulling the active circuit into a cohesive 3D orbital cluster around the parent.
5. **Relaxation:** Clicking empty space or pressing `Escape` triggers a deep sub-bass sweep (160 Hz $\rightarrow$ 65 Hz) and returns the universe to resting equilibrium.

### Neo4j Desktop Integration
- **Target DBMS:** Named **`Exocortex`** (ID: `fb85c09a-5124-4df7-9128-1bb9cfea6036`).
- **HTTP Endpoint:** `http://127.0.0.1:7474` (Cypher transactional commit).
- **Bolt Endpoint:** `bolt://127.0.0.1:7687` (Desktop graph browser).
- **Continuous Synchronizer:** Daemon synchronizes entity states into Neo4j nodes and edges with idempotent `MERGE` Cypher statements.

---

## 3. Telemetry Pipelines & Data Ingestion ("What Feeds What")

The Exocortex is only as smart as its sensory inputs. Telemetry flows through a multi-tiered pipeline designed to operate offline, survive app crashes, and prevent duplicate ingestion.

### Signal Ingestion Sources

```
[ Android Phone Sensors ]                [ Workstation Sensors ]
  ├── Accessibility Scanner                 ├── PiecesOS OS Server (39300)
  ├── Notification Listener                 │     ├── Workstream Summaries
  └── SMS Backfill Engine                   │     └── Asset Annotations
            │                               └── CLI & Editor Activity
            ▼                                           │
  [ Local SQLite Outbox ]                               │
            │ (Plan A / Plan B Failover)                │
            └───────────────┬───────────────────────────┘
                            ▼
              [ exocortexd Gateway (:8788) ]
                            │
                            ▼
             [ Hash-Chained Event Log (WAL) ]
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
  [ Living World Model ]          [ Sovereign Databank ]
  (Decayed Activations)          (Parquet / Archival)
```

1. **Android Accessibility Service (`AccessibilityScanner`):**
   - Captures on-screen UI text, package identifiers, and view hierarchy nodes from allowlisted applications.
   - Screen-context capture requires explicit user opt-in in system settings.
2. **Notification Listener (`NotificationCaptureService`):**
   - Intercepts incoming system notifications, redacting sensitive tokens and parsing transactional notifications into structured events.
3. **SMS Backfill Engine (`smsBackfill.ts`):**
   - Ingests message history using an epoch-millisecond high-water mark (`smsBackfillHighWater`).
   - Advanced page-by-page so that mid-backfill interrupts resume cleanly without duplicate processing.
4. **PiecesOS Workstream Pipeline (`apps/proxy`):**
   - Connects to local PiecesOS engine on port `39300`.
   - Ingests AI-generated developer workstream summaries, asset metadata, and local vector embeddings.

### Failover Transport: Plan A vs. Plan B
Every event emitted by the phone uses resilient dual-profile routing:
- **Plan A (Fast LAN):** Direct HTTP request to `http://<LAN_IP>:8787`. Probed with a 2500ms timeout.
- **Plan B (Remote Gateway):** Secure HTTPS fallback via Tailscale reverse proxy `http://127.0.0.1:8788`.
- If both fail, events remain safely in the phone's **SQLite Outbox** and flush automatically when connectivity is restored.

### "What Feeds What" Data Flow Matrix

| Source Component | Output Signal / Data | Ingestion Destination | Ingested State & Impact |
|---|---|---|---|
| **Android Accessibility** | Active package, focused text, UI hierarchy | `POST /mobile/telemetry` | Spreads activation to corresponding `PROJECT` and `TOPIC` nodes; increments dwell counters. |
| **Notification Listener** | Sender, message snippet, category | `POST /mobile/notifications` | Triggers immediate triage scoring; updates `PERSON` relationship recency. |
| **SMS Backfill** | Contact phone, timestamp, direction | `POST /mobile/sms` | Reconstructs historical interaction frequency edges in the Life Graph. |
| **PiecesOS Engine** | Workstream summaries, code snippets | `POST /v3/events` | Ingests developer context; connects active files to `PROJECT` nodes. |
| **Hash-Chained Log** | Deterministic event stream | `packages/world-model` | Computes exponential decay ($e^{-\lambda t}$) and spreading activation. |
| **World Model** | Graph topology & activations | `apps/daemon/src/neo4j-sync` | Synchronizes nodes and relationships into the Neo4j `Exocortex` DBMS. |
| **World Model** | Active entities & context | `packages/world-model/src/active-inference` | Evaluates generative matrices (A, B, C, D) to compute policy expected free energy. |
| **User Touch Feedback** | `wanted` / `not_wanted` tap | `POST /v3/proposals/:id/feedback` | Trains proposal ranking weights and updates the precision evaluation baseline. |

---

## 4. The Cognitive Core & Pre-Cognitive Engine

The Exocortex does not use an opaque, hallucinating LLM to make operational decisions. Its core is a deterministic mathematical engine that computes beliefs, attentional states, and action policies.

### The Cognitive Mode Gate
Incoming notifications and proposed interruptions pass through the **Cognitive Mode Gate**, which tracks your current mental phase:

```
[ DEEP_FOCUS ] ────────────► Interrupt threshold: VERY HIGH (Security/Critical Only)
[ HIGH_VELOCITY_EXECUTION ] ► Interrupt threshold: HIGH (Current Task Context Only)
[ EXPLORATORY_LEARNING ] ───► Interrupt threshold: MODERATE (Related Topics Allowed)
[ MAINTENANCE_SURFACING ] ──► Interrupt threshold: LOW (Staged Upkeep & Backlog)
[ REST_RECOVERY ] ──────────► Interrupt threshold: SILENT (Queue All for Later)
```

Transitions between modes occur based on signal entropy, keystroke velocity, active applications, and time of day.

### Active Inference Engine
Action selection uses the mathematics of **Active Inference**:
- **A Matrix (Observation Likelihood):** Maps internal cognitive states to expected sensory signals.
- **B Matrix (Transition Probabilities):** Predicts how the world changes under specific actions.
- **C Matrix (Prior Preferences):** Defines the user's desired states (e.g., low distraction, completed tasks).
- **D Matrix (Initial Beliefs):** Baseline priors over initial states.

The policy $\pi$ that minimizes **Expected Free Energy (EFE)** is chosen:

$$G(\pi) = \sum_\tau G(\pi, \tau)$$

Where policies with low risk (epistemic value) and high utility (pragmatic value) are promoted to the Pending Proposals queue.

### Pre-Cognitive Anticipation Ring
Located on the mobile companion (`AnticipationRing.tsx`), this engine predicts your intent *before* you finish touching the screen:
- **$p_{20}$ Wake-Quantile Calibration:** Measures historical touch-dwell times and executes pre-warming at the 20th percentile of dwell duration.
- **Speculative Cache Pre-Warming:** If your finger rests on a proposal card for more than 140ms, the engine pre-fetches the action payload and primes the cryptographic verification pipeline.

---

## 5. Hardware Security, Cryptographic Keystores & Approvals

Safety is enforced through hardware cryptography, not software permissions.

```
Host Daemon (:8788)                             Android Phone Enclave
        │                                                 │
        │  1. Proposal Staged (Single-Use Nonce Issued)   │
        ├────────────────────────────────────────────────►│
        │                                                 │
        │                                          [BiometricPrompt]
        │                                          Fingerprint Verified
        │                                                 │
        │                                          Hardware Keystore
        │                                          Signs Nonce with ECC
        │                                                 │
        │  2. Signed Payload + Attestation Chain          │
        │◄────────────────────────────────────────────────┤
        │                                                 │
  [Gate Verification]                                     │
  - Check single-use nonce                                │
  - Verify signature against enclave cert                 │
  - Confirm risk tier <= capability grant                 │
        │                                                 │
  3. Execute via Mesh / Triad                             │
```

1. **Hardware Keystore Isolation:** Keys are generated in Android's `AndroidKeyStore` provider with `PURPOSE_SIGN` and `setUserAuthenticationRequired(true)`. The private key never leaves the hardware security enclave.
2. **Single-Use Anti-Replay Nonces:** When a proposal is generated, the daemon issues a cryptographically random nonce with a 60-second time-to-live. The nonce is consumed upon signature verification, preventing replay attacks.
3. **Fail-Closed Execution:** If the biometric prompt is canceled, timed out, or attestation validation fails, the proposal is discarded and logged to the shadow registry.

---

## 6. Autonomous Multi-Agent Triad & Agent Mesh

The Exocortex is maintained and extended by a collaborative triad of specialized AI coding agents.

### The Triad Roles

| Agent | Core Superpower | Responsibilities |
|---|---|---|
| **Antigravity** | **Primary Executive Engine** | Drives interactive development, executes shell commands, runs test suites, manages 2M token trees, and applies surgical file edits. |
| **Claude Code & OpenAI Codex** | **Chief Architect & Advisory Council** | High-availability advisory bridge: Claude 3.7 Sonnet (Claude Pro) with automatic zero-downtime failover to OpenAI Codex (`gpt-6-astra`). Performs pre-commit diff analysis and architectural fork validation. |
| **Hermes Agent** | **Mobile Automation & Batch Specialist** | Handles mobile phone automation via the Android bridge relay (`:8766`), Nous portable `SKILL.md` workflows, and free batch background runs. |

### The Agent Mesh MCP Router (`packages/mesh`)
- **123 Tool Endpoints:** Exposes local and system capabilities via the Model Context Protocol.
- **Two-Phase Patch Promotion:** Agent-generated patches are executed in isolated sandboxes, validated against test suites, and promoted to the main branch only upon passing all verification gates.

---

## 7. Operator Runbook & Troubleshooting

### Local Service Ports & Health Check Matrix

| Port | Service | Process / Host | Verification Command |
|---|---|---|---|
| **8788** | Exocortex Daemon Gateway | `node.exe` (Scheduled Task: `ExocortexDaemon`) | `curl http://127.0.0.1:8788/mobile/health` |
| **8787** | Pieces Android Proxy | `node.exe` (Scheduled Task: `PiecesAndroidProxy`) | `curl http://127.0.0.1:8787/health` |
| **39300** | PiecesOS Core REST API | `os_server.exe` (Windows Service) | `curl http://127.0.0.1:39300/is_alive` |
| **7474** | Neo4j HTTP Query API | `java.exe` (Neo4j Desktop `Exocortex` DBMS) | `curl http://127.0.0.1:7474` |
| **7687** | Neo4j Bolt Protocol | `java.exe` (Neo4j Desktop `Exocortex` DBMS) | Test-NetConnection -Port 7687 |
| **8766** | Hermes Android Relay | `python.exe` (`android-relay-env`) | WebSocket listener |

### Common Operational Procedures

#### Starting the Exocortex Daemon
The daemon runs as a Windows Scheduled Task (`ExocortexDaemon`) configured to start at boot:
```powershell
# Check status
Get-ScheduledTask -TaskName "ExocortexDaemon"

# Restart daemon
Restart-ScheduledTask -TaskName "ExocortexDaemon"
```

#### Starting Neo4j Desktop
1. Open **Neo4j Desktop** from your start menu or system tray.
2. Select the project containing the **`Exocortex`** DBMS (ID: `fb85c09a-5124-4df7-9128-1bb9cfea6036`).
3. Click the blue **Start** button.
4. Verify port 7474 responds:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:7474"
   ```

#### Compiling Desktop Release Packages
To compile fresh Windows setup installers:
```powershell
cd apps/desktop && npx tauri build
```
Artifacts are emitted to:
- `apps/desktop/src-tauri/target/release/bundle/nsis/Sovereign Exocortex_1.0.0_x64-setup.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Sovereign Exocortex_1.0.0_x64_en-US.msi`

#### Re-pairing Mobile Companion
If the mobile app shows "Proxy Not Configured":
1. Ensure your PC and phone are on the same Wi-Fi network, or Tailscale is active.
2. In the mobile app, open **Settings $\rightarrow$ Setup**.
3. Tap **Auto-Pair with Local PC** (or scan the pairing QR code from the Desktop Command Center).
4. Verify both health checks show green checkmarks.

---

### Emergency Safety Circuit Breakers
- **Immediate Pause:** Setting `SHADOW=1` in `apps/daemon/.env` immediately halts all live action staging and restricts the system to pure observation and telemetry logging.
- **Revoke Device Grants:** Delete the device JWT from `apps/daemon/secrets/` to instantly revoke phone access without restarting the daemon.
