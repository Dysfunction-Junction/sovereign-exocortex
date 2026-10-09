#!/usr/bin/env python3
"""
Autonomous Multi-Agent Triad: Nous Research Bridge (triad/nous_bridge.py).
Zero-cost advisory inference via the Nous Portal API, using task-aware free
model cascades (see TASK_MODEL_CASCADES) with automatic 429/empty-content
failover across each cascade. Worst case is len(cascade) sequential HTTP
calls, each up to `timeout` seconds — not sub-second.
- Reads the Nous OAuth bearer token from Hermes auth.json or NOUS_API_KEY.
- Integrates into advisor_manager.py and advisors.json as the "nous" advisor.
"""

import sys
import os
import json
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional, Tuple, List

def _default_hermes_home() -> Path:
    # Path components, not a raw "~\..." string -- os.path.expanduser only
    # expands "~" when it's followed by "/" or end-of-string, so a literal
    # "~\AppData\..." never expands on POSIX and yields a broken relative path.
    return Path.home() / "AppData" / "Local" / "hermes"


_hermes_home_env = os.environ.get("HERMES_HOME")
if _hermes_home_env:
    HERMES_HOME = Path(os.path.expanduser(_hermes_home_env))
else:
    HERMES_HOME = _default_hermes_home()
AUTH_FILE = HERMES_HOME / "auth.json"
INFERENCE_URL = "https://inference-api.nousresearch.com/v1/chat/completions"

# Task-specific prioritized free model cascades:
# Directs each query to the best model for that specific job, with automatic cascading failover
TASK_MODEL_CASCADES = {
    "coding": [
        "poolside/laguna-xs-2.1:free",      # Specialized code intelligence (1.8s ultra-fast)
        "upstage/solar-pro4:free",           # High-precision logic & bug detection fallback
        "stepfun/step-3.7-flash:free",       # Fast flash fallback
        "poolside/laguna-s-2.1:free",        # Deep code model
    ],
    "architecture": [
        "upstage/solar-pro4:free",           # Flagship general reasoning & structural critique
        "poolside/laguna-xs-2.1:free",       # Fast code architecture check
        "stepfun/step-3.7-flash:free",       # Flash reasoning fallback
    ],
    "mobile": [
        "stepfun/step-3.7-flash:free",       # Ultra-responsive low-latency mobile tool actions
        "upstage/solar-pro4:free",           # Reasoning fallback for complex phone tasks
        "poolside/laguna-xs-2.1:free",
    ],
    "general": [
        "upstage/solar-pro4:free",           # Balanced general knowledge & advice
        "stepfun/step-3.7-flash:free",
        "poolside/laguna-xs-2.1:free",
    ],
}


def detect_task_category(prompt: str, mode: Optional[str] = None) -> str:
    """Classifies prompt into task category to select the optimal free model."""
    if mode in ("review_diff", "debug"):
        return "coding"
    if mode in ("architect", "consult"):
        return "architecture"

    p_lower = prompt.lower()
    if any(k in p_lower for k in ("diff --git", "traceback", "def ", "class ", "import ", "syntaxerror", "bug", "patch")):
        return "coding"
    if any(k in p_lower for k in ("architecture", "system design", "schema", "scalability", "tradeoff", "consensus")):
        return "architecture"
    if any(k in p_lower for k in ("phone", "android", "screen", "sms", "notification", "battery", "relay")):
        return "mobile"
    return "general"


def get_nous_token() -> Optional[str]:
    """Retrieve Nous API token from environment or Hermes auth.json."""
    env_token = os.environ.get("NOUS_API_KEY")
    if env_token and env_token.strip():
        return env_token.strip()

    if AUTH_FILE.exists():
        try:
            with open(AUTH_FILE, "r", encoding="utf-8", errors="replace") as f:
                data = json.load(f)
            nous_auth = data.get("providers", {}).get("nous", {})
            # Validate each candidate before accepting it -- a whitespace-only
            # or non-string agent_key must not shadow a valid access_token.
            for key in ("agent_key", "access_token"):
                token = nous_auth.get(key)
                if isinstance(token, str) and token.strip():
                    return token.strip()
        except Exception:
            pass
    return None


def query_nous(
    prompt: str,
    model: Optional[str] = None,
    mode: Optional[str] = None,
    timeout: int = 25,
    budget_seconds: float = 100.0,  # wall-clock ceiling, stays under advisor_manager's 120s subprocess timeout
) -> Tuple[bool, str, str, bool]:
    """
    Query Nous Portal API with task-aware optimal model routing and automatic cascading failover.
    Returns: (success, content_or_error, model_used, all_rate_limited)
    `all_rate_limited` is True only when every attempted model failed with HTTP 429 --
    callers (main()) use this to decide whether to signal a rate-limit verdict, instead
    of re-parsing the error string.
    """
    import time

    token = get_nous_token()
    if not token:
        return False, "Error: No Nous credentials found (checked NOUS_API_KEY and Hermes auth.json)", "", False

    task_category = detect_task_category(prompt, mode=mode)
    cascade = TASK_MODEL_CASCADES.get(task_category, TASK_MODEL_CASCADES["general"])

    # Determine candidate models to try
    models_to_try: List[str] = []
    if model:
        models_to_try.append(model)
    env_model = os.environ.get("NOUS_MODEL")
    if env_model and env_model not in models_to_try:
        models_to_try.append(env_model)
    for m in cascade:
        if m not in models_to_try:
            models_to_try.append(m)

    last_error = ""
    attempted_count = 0
    rate_limited_count = 0
    deadline = time.monotonic() + budget_seconds
    for candidate_model in models_to_try:
        remaining = deadline - time.monotonic()
        if remaining < 2:
            last_error = last_error or "wall-clock budget exhausted before all models were attempted"
            break
        attempt_timeout = min(timeout, remaining)
        attempted_count += 1
        payload = {
            "model": candidate_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an expert AI software architect and code reviewer on the Autonomous Triad Advisory Council. "
                        "Provide dense, direct, technically rigorous analysis and exact code snippets with zero conversational filler."
                    )
                },
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.2
        }

        req = urllib.request.Request(
            INFERENCE_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "Autonomous-Triad/3.0"
            }
        )

        try:
            # B310 suppressed below: INFERENCE_URL is a hardcoded https:// constant, no injection surface
            with urllib.request.urlopen(req, timeout=attempt_timeout) as response:  # nosec B310
                res_data = json.loads(response.read().decode("utf-8"))
                choices = res_data.get("choices", [])
                if choices:
                    finish_reason = choices[0].get("finish_reason")
                    content = ((choices[0].get("message") or {}).get("content") or "").strip()
                    if content and finish_reason != "length":
                        return True, content, candidate_model, False
                    if content:
                        last_error = f"truncated response (finish_reason=length) from {candidate_model}"
                    else:
                        last_error = f"empty content from {candidate_model}"
                else:
                    last_error = f"no choices in response from {candidate_model}"
                print(f"[Nous Failover] Model {candidate_model} response unusable ({last_error}). Falling back to next free model in {task_category} cascade...", file=sys.stderr)
                continue
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8")
            except Exception:
                pass
            err_body = " ".join(err_body.split())[:300]  # collapse to one line, cap length
            last_error = f"HTTP {e.code}: {err_body or e.reason}"
            if e.code == 429:
                rate_limited_count += 1
            elif e.code in (401, 403):
                # Bad/expired token -- every model will fail identically, don't burn the cascade.
                last_error = f"HTTP {e.code}: auth rejected ({err_body or e.reason})"
                print(f"[Nous Failover] Auth rejected ({last_error}); aborting cascade early.", file=sys.stderr)
                return False, f"Nous auth failed: {last_error}", "", False
            # Log failover transition to next model in cascade
            print(f"[Nous Failover] Model {candidate_model} unavailable ({last_error}). Falling back to next free model in {task_category} cascade...", file=sys.stderr)
            continue
        except Exception as e:
            last_error = str(e)
            print(f"[Nous Failover] Model {candidate_model} failed ({last_error}). Falling back to next free model in {task_category} cascade...", file=sys.stderr)
            continue

    all_rate_limited = attempted_count > 0 and rate_limited_count == attempted_count
    verdict = "a rate limit" if all_rate_limited else "an error"
    return False, f"All Nous models hit {verdict} in {task_category} cascade. Last error: {last_error}", "", all_rate_limited


def main():
    # Ensure UTF-8 I/O — scoped to CLI entry so importing this module (e.g. from
    # triad_engine.py's cmd_doctor) doesn't reconfigure the importer's own streams.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    import argparse
    parser = argparse.ArgumentParser(description="Nous Research Portal Bridge")
    parser.add_argument("prompt", nargs="?", default="", help="Prompt text")
    parser.add_argument("--mode", default=None, help="Query mode (review_diff, debug, architect, etc.)")
    parser.add_argument("--model", default=None, help="Explicit model override")
    args, unknown = parser.parse_known_args()

    prompt = args.prompt
    if not prompt:
        prompt = sys.stdin.read().strip()

    if not prompt:
        print("Error: Empty prompt provided to nous_bridge", file=sys.stderr)
        sys.exit(1)

    success, result, model_used, all_rate_limited = query_nous(prompt, model=args.model, mode=args.mode)
    if success:
        print(result)
        sys.exit(0)
    elif all_rate_limited:
        # Printed to stdout (not stderr) so advisor_manager.py's existing
        # "rate limit" in output.lower() check recognizes this as a session
        # limit without any change to that shared classifier.
        print(f"[Nous Rate Limit]: {result}")
        sys.exit(1)
    else:
        print(f"[Nous Error]: {result}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
