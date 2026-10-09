#!/usr/bin/env python3
"""
Triad Phone Notification Bridge (notifier.py).
Connects autonomous Triad event completions to Bear House Classic push alerts
(targeting user's Galaxy S26 Ultra via /api/triad-notify or /api/notify-person).
"""

import json
import os
import threading
import urllib.request
import urllib.error
from typing import Optional


import time
import atexit

MAX_CONCURRENT_NOTIFICATIONS = 8
_dispatch_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_NOTIFICATIONS)
_active_threads_lock = threading.Lock()
_active_threads = []


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Blocks automatic redirects so a scheme/host check on the original URL can't be bypassed
    (the primary request carries a bearer token that must not follow a redirect to another host)."""
    def redirect_request(self, *args, **kwargs):
        return None


# Installed as the default opener so plain urllib.request.urlopen() calls
# below stay mockable in tests while still disabling redirects for real.
urllib.request.install_opener(urllib.request.build_opener(_NoRedirectHandler))


def _send_network_payload(
    title: str,
    body: str,
    status: str = "info",
    person: Optional[str] = None,
    timeout: float = 1.0,
    outcome: Optional[list] = None,
    deadline: Optional[float] = None
) -> bool:
    """Perform direct network I/O with monotonic timeout deadline."""
    if deadline is None:
        deadline = time.monotonic() + max(0.01, timeout)
    try:
        bear_house_url = os.environ.get("BEAR_HOUSE_URL", "http://localhost:5173").rstrip("/")
        bearer_token = os.environ.get("BEAR_HOUSE_TOKEN", "")

        icon = "✓" if status == "success" else ("❌" if status in ("error", "failed") else "⚡")
        full_title = f"{icon} {title}"

        endpoint = f"{bear_house_url}/api/triad-notify"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Autonomous-Triad/1.0"
        }
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"

        payload_data = {
            "title": full_title,
            "body": body,
            "status": status,
            "source": "autonomous-triad"
        }
        if person:
            payload_data["person"] = person

        payload = json.dumps(payload_data).encode("utf-8")

        # Check if fallback is configured
        ifttt_key = os.environ.get("IFTTT_WEBHOOKS_KEY", "")

        # 1. Bear House /api/triad-notify
        rem = deadline - time.monotonic()
        if rem > 0:
            # If fallback is configured, reserve portion of deadline so primary timeout does not starve fallback
            if ifttt_key:
                primary_timeout = max(0.02, min(rem * 0.5, rem - 0.05))
            else:
                primary_timeout = rem
            try:
                req = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
                if req.type not in ("http", "https"):
                    raise ValueError(f"Refusing non-HTTP(S) URL scheme: {req.type}")
                # B310 suppressed below: scheme validated above, redirects disabled via installed opener
                with urllib.request.urlopen(req, timeout=primary_timeout) as resp:  # nosec B310
                    if 200 <= resp.status < 300:
                        if outcome is not None:
                            outcome[0] = True
                        return True
            except Exception:
                pass

        # 2. IFTTT Maker Webhooks Fallback
        if ifttt_key:
            rem = deadline - time.monotonic()
            if rem > 0:
                try:
                    ifttt_url = f"https://maker.ifttt.com/trigger/triad_alert/with/key/{ifttt_key}"
                    ifttt_payload = json.dumps({
                        "value1": full_title,
                        "value2": body,
                        "value3": status
                    }).encode("utf-8")
                    req = urllib.request.Request(
                        ifttt_url,
                        data=ifttt_payload,
                        headers={"Content-Type": "application/json"},
                        method="POST"
                    )
                    # B310 suppressed below: hardcoded literal https:// URL, no injection surface
                    with urllib.request.urlopen(req, timeout=rem) as resp:  # nosec B310
                        if 200 <= resp.status < 300:
                            if outcome is not None:
                                outcome[0] = True
                            return True
                except Exception:
                    pass
    except Exception:
        pass

    return False


def _network_delivery_worker(
    sem: threading.BoundedSemaphore,
    title: str,
    body: str,
    status: str,
    person: Optional[str],
    deadline: float,
    outcome: list
):
    try:
        rem = deadline - time.monotonic()
        if rem > 0:
            _send_network_payload(title, body, status, person, timeout=rem, outcome=outcome, deadline=deadline)
    finally:
        try:
            sem.release()
        except ValueError:
            pass
        with _active_threads_lock:
            cur = threading.current_thread()
            if cur in _active_threads:
                _active_threads.remove(cur)


def _dispatch_sync(
    title: str,
    body: str,
    status: str = "info",
    person: Optional[str] = None,
    timeout: float = 1.0
) -> bool:
    deadline = time.monotonic() + max(0.01, timeout)
    rem = deadline - time.monotonic()
    if rem <= 0:
        return False
    sem = _dispatch_semaphore
    acquired = sem.acquire(timeout=rem)
    if not acquired:
        return False

    outcome = [False]
    t = threading.Thread(
        target=_network_delivery_worker,
        args=(sem, title, body, status, person, deadline, outcome),
        daemon=True
    )
    try:
        with _active_threads_lock:
            t.start()
            _active_threads.append(t)
    except Exception:
        sem.release()
        return False

    join_rem = deadline - time.monotonic()
    if join_rem > 0:
        t.join(timeout=join_rem)
    return outcome[0]


def flush_notifications(timeout: float = 2.0) -> None:
    """
    Wait for all in-flight asynchronous notifications to complete delivery before process exit.
    Bounded by the specified monotonic timeout. Handles overlapping registrations.
    """
    deadline = time.monotonic() + max(0.0, timeout)
    joined = set()
    while True:
        with _active_threads_lock:
            alive = []
            for t in _active_threads:
                is_alive_fn = getattr(t, "is_alive", None)
                if callable(is_alive_fn) and is_alive_fn():
                    alive.append(t)
            _active_threads[:] = alive
            unjoined = [t for t in _active_threads if id(t) not in joined]
            if not unjoined:
                break
            thread_to_join = unjoined[0]
            joined.add(id(thread_to_join))

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        thread_to_join.join(timeout=remaining)
    with _active_threads_lock:
        _active_threads[:] = [t for t in _active_threads if getattr(t, "is_alive", lambda: False)()]


atexit.register(flush_notifications)


def notify_event(
    title: str,
    body: str,
    status: str = "info",
    person: Optional[str] = None,
    timeout: float = 1.0,
    async_dispatch: bool = False
) -> bool:
    """
    Send push notification to phone via Bear House Classic push bridge.

    If async_dispatch is True:
        Dispatches in a managed background thread so calling code is not blocked.
        Returns True to indicate the event has been successfully *queued* for dispatch.
        An atexit hook automatically flushes any in-flight requests on process exit.
    If async_dispatch is False (default):
        Dispatches synchronously with bounded network timeout and returns True if and only if
        the event was accepted by the remote endpoint (2xx status code).
        Recommended for CLI completion events and exit-blocking gates.
    """
    if async_dispatch:
        sem = _dispatch_semaphore
        acquired = sem.acquire(blocking=False)
        if not acquired:
            return False
        deadline = time.monotonic() + max(0.01, timeout)

        outcome = [False]
        t = threading.Thread(
            target=_network_delivery_worker,
            args=(sem, title, body, status, person, deadline, outcome),
            daemon=True
        )
        try:
            with _active_threads_lock:
                t.start()
                _active_threads.append(t)
            return True
        except Exception:
            sem.release()
            return False
    return _dispatch_sync(title, body, status, person, timeout)
