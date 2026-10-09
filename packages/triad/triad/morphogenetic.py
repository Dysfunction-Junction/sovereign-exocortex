#!/usr/bin/env python3
"""
morphogenetic.py
Frontier 3 of the Magic Piece: Morphogenetic Software Engine (Immortal Self-Healing).

Transforms software from brittle static source code into an evolving digital organism:
1. Biological Exception Interception: Catches runtime crashes, schema drift, and friction.
2. Ephemeral Worktree Mutation: Spawns sandboxed git worktrees isolated from live process.
3. Darwinian Survival Gates: Verifies syntax, security invariants, and 100% test pass rate.
4. Apoptosis: Instant purging of failing mutations.
5. Zero-Downtime Hot Splicing: Generates verified two-phase patch for live promotion.
"""

import sys
import os
import subprocess
import shutil
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable, Union
from triad.worktree import isolated_worktree, create_worktree, remove_worktree

logger = logging.getLogger("exocortex.morphogenetic")


@dataclass
class RuntimeFrictionEvent:
    event_id: str
    error_type: str
    message: str
    stack_trace: str
    failing_file: Optional[str] = None
    failing_line: Optional[int] = None
    repo_path: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MutationCandidate:
    candidate_id: str
    description: str
    target_file: str
    original_code: str
    mutated_code: str
    unified_diff: str = ""
    survival_passed: bool = False
    verification_output: str = ""


class MorphogeneticEngine:
    def __init__(self, repo_root: Optional[Union[str, Path]] = None):
        self.repo_root = Path(repo_root or os.getcwd()).resolve()

    def intercept_friction(
        self,
        error: Exception,
        failing_file: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> RuntimeFrictionEvent:
        """Create a structured runtime friction event from an exception."""
        import traceback
        return RuntimeFrictionEvent(
            event_id=f"friction_{os.urandom(4).hex()}",
            error_type=type(error).__name__,
            message=str(error),
            stack_trace=traceback.format_exc(),
            failing_file=failing_file,
            repo_path=str(self.repo_root),
            context=context or {},
        )

    def _resolve_within(self, root: Path, rel: str) -> tuple[Optional[Path], Optional[str]]:
        """
        Resolves a relative file path within a root directory.
        Guarantees path containment within root and checks that target is a regular file.
        """
        resolved_root = root.resolve()
        target = (resolved_root / rel).resolve()
        if not target.is_relative_to(resolved_root):
            return None, f"escapes sandbox: {rel}"
        if not target.is_file():
            return None, f"is not a regular file or does not exist: {rel}"
        return target, None

    def evaluate_mutation_in_sandbox(
        self,
        candidate: MutationCandidate,
        verification_command: List[str],
        base_commit: str = "HEAD",
    ) -> bool:
        """
        Spawns an isolated git worktree, applies the candidate mutation,
        and executes Darwinian survival tests. If tests fail, the mutation undergoes
        apoptosis (immediate discard). If 100% pass, the mutation survives.
        """
        candidate.survival_passed = False

        try:
            with isolated_worktree(
                str(self.repo_root),
                branch_or_commit=base_commit,
                prefix=f"morpho_{candidate.candidate_id}",
            ) as sandbox_path:
                sandbox = Path(sandbox_path).resolve()
                target_file_path, err = self._resolve_within(sandbox, candidate.target_file)

                # Path containment & file existence guard
                if err or not target_file_path:
                    candidate.verification_output = f"Darwinian Rejection: target {err}"
                    return False

                # 1. Apply mutation in the ephemeral sandbox
                original_content = target_file_path.read_text(encoding="utf-8")
                candidate.original_code = original_content

                # No-op guard: normalize newlines to avoid platform LF/CRLF mismatches
                orig_norm = original_content.replace("\r\n", "\n")
                mut_norm = candidate.mutated_code.replace("\r\n", "\n")
                if mut_norm == orig_norm:
                    candidate.verification_output = "Darwinian Rejection: mutation is a no-op"
                    return False

                target_file_path.write_text(candidate.mutated_code, encoding="utf-8")

                # 2. Strict Invariant Check: Zero forbidden tokens / regressions
                raw_forbidden = os.environ.get("FORBIDDEN_MUTATION_TOKENS", "deprecated_root_api,banned_proxy")
                forbidden_tokens = [t.strip().lower() for t in raw_forbidden.split(",") if t.strip()]
                for token in forbidden_tokens:
                    if token in candidate.mutated_code.lower():
                        candidate.verification_output = f"Darwinian Rejection: Mutation violated architectural invariant (found forbidden token '{token}')"
                        return False

                # 3. Darwinian Survival Gate: Execute test harness
                res = subprocess.run(
                    verification_command,
                    cwd=str(sandbox),
                    capture_output=True,
                    text=True,
                    timeout=120,
                )

                candidate.verification_output = (res.stdout + "\n" + res.stderr).strip()

                if res.returncode == 0:
                    candidate.survival_passed = True
                    # Generate verified git diff
                    diff_res = subprocess.run(
                        ["git", "diff", "--", candidate.target_file],
                        cwd=str(sandbox),
                        capture_output=True,
                        text=True,
                    )
                    candidate.unified_diff = diff_res.stdout
                    return True
                else:
                    # Apoptosis
                    candidate.survival_passed = False
                    return False

        except Exception as e:
            candidate.verification_output = f"Sandbox Darwinian execution error: {str(e)}"
            candidate.survival_passed = False
            return False

    def synthesize_repair_candidate(
        self,
        event: RuntimeFrictionEvent,
        patch_strategy_fn: Optional[Callable[[str, RuntimeFrictionEvent], str]] = None,
    ) -> Optional[MutationCandidate]:
        """
        Synthesizes a candidate mutation given a friction event.
        Can use an external LLM advisory strategy function or deterministic heuristic.
        """
        if not event.failing_file:
            return None

        target_file_path, err = self._resolve_within(self.repo_root, event.failing_file)
        if err or not target_file_path:
            return None

        content = target_file_path.read_text(encoding="utf-8")

        if patch_strategy_fn:
            mutated = patch_strategy_fn(content, event)
        else:
            mutated = content

        return MutationCandidate(
            candidate_id=f"mut_{os.urandom(4).hex()}",
            description=f"Automated morphogenetic repair for {event.error_type}: {event.message[:80]}",
            target_file=event.failing_file,
            original_code=content,
            mutated_code=mutated,
        )
