#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hardened Benchmark Harness for Autonomous Multi-Agent Triad.
Uses model-as-a-judge scoring (replacing keyword matching) and negative controls.
"""

import sys
import os
import re
import json
import argparse
from pathlib import Path
from typing import Dict, Any, List, Tuple

# Ensure UTF-8 output on Windows consoles and redirected streams
os.environ["PYTHONIOENCODING"] = "utf-8"
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Ensure parent repo root and triad directory are importable
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TRIAD_ROOT = Path(__file__).resolve().parent.parent
for p in [str(REPO_ROOT), str(TRIAD_ROOT)]:
    if p not in sys.path:
        sys.path.insert(0, p)

from triad_engine import query_advisory_council, query_claude, query_codex

DEFAULT_CASES_DIR = Path(__file__).resolve().parent / "cases"

class JudgeUnavailableError(RuntimeError):
    """Raised when judging instruments cannot provide an authoritative evaluation."""
    pass


def _keep_claude_as_judge(engine: str, judge_engine: str) -> str:
    """Codex does not grade a patch it authored. Claude judging Claude is the design."""
    if engine == "codex" and judge_engine in ("codex", "asymmetric"):
        print(
            "[Triad] Claude judges this run. Codex authored the candidate and does not grade its own patch.",
            file=sys.stderr,
        )
        return "claude"
    return judge_engine

def _judge_response_failed(text: str) -> bool:
    """True when the judge did not answer. A rationale that merely says "limit" is still an answer."""
    if not text or not str(text).strip():
        return True
    lower = str(text).lower()
    return "[error" in lower or "rate limit" in lower or "session limit" in lower


def _codex_may_grade(author_engine: str, fallback_name: str) -> bool:
    """Codex does not grade a patch it authored, including after Claude fails."""
    return not (author_engine == "codex" and fallback_name == "codex")


def query_judge(prompt: str, timeout: int = 90, *, judge_engine: str = "claude", author_engine: str = "") -> str:
    """
    Independent judging instrument.

    Claude is the primary judge. Codex answers only when Claude cannot.
    ``judge_engine="asymmetric"`` or ``"codex"`` is an explicit Codex-first override.
    """
    # Each advisor call takes its own session slot and releases it before failover.
    primary = "codex" if judge_engine in ("asymmetric", "codex") else "claude"
    ask = query_codex if primary == "codex" else query_claude
    fallback_name = "claude" if primary == "codex" else "codex"
    fallback = query_claude if primary == "codex" else query_codex
    verdict = ask(prompt, mode="general", timeout=timeout)
    judged_by = primary
    if _judge_response_failed(verdict):
        if not _codex_may_grade(author_engine, fallback_name):
            print(
                "[Triad] Claude could not judge this Codex-authored patch. Codex will not grade it.",
                file=sys.stderr,
            )
        else:
            verdict = fallback(prompt, mode="general", timeout=timeout)
            judged_by = fallback_name
            print(
                f"[Triad] Judge failover: {primary} could not answer; {judged_by} judged this item.",
                file=sys.stderr,
            )

    if _judge_response_failed(verdict):
        clean_err = verdict.strip().replace("\n", " ") if verdict else "Empty response"
        raise JudgeUnavailableError(f"Judge models unavailable (Claude and Codex rate-limited or offline): {clean_err[:120]}")
    return verdict

def _parse_judge_verdict(verdict: str) -> bool:
    """
    Strictly parse YES or NO from judge response.
    Fails closed by raising JudgeUnavailableError on ambiguity, errors, or unexpected formatting.
    """
    if not verdict or not verdict.strip():
        raise JudgeUnavailableError("Judge returned empty verdict")
    
    # Check first line/token
    lines = [l.strip() for l in verdict.strip().splitlines() if l.strip()]
    first_token = lines[0].split()[0]
    clean_word = re.sub(r"[^\w]", "", first_token).upper()
    
    if clean_word == "YES":
        return True
    elif clean_word == "NO":
        return False
    
    # If first token is markdown-wrapped or punctuation, check all tokens on first line
    first_line_tokens = [re.sub(r"[^\w]", "", t).upper() for t in lines[0].split()]
    if "YES" in first_line_tokens and "NO" not in first_line_tokens:
        return True
    elif "NO" in first_line_tokens and "YES" not in first_line_tokens:
        return False
        
    raise JudgeUnavailableError(f"Judge returned non-boolean response: {verdict[:100]}")

def judge_catch(bug_description: str, review_response: str, *, judge_engine: str = "claude", author_engine: str = "") -> bool:
    """
    Ask a model whether the review response specifically and correctly identifies
    the seeded bug anywhere in its findings, rather than relying on presentation order.
    """
    judge_prompt = (
        "You are scoring a code review for accuracy, not presentation order.\n\n"
        f"THE ACTUAL BUG: {bug_description}\n\n"
        f"THE REVIEW RESPONSE TO SCORE:\n{review_response}\n\n"
        "Does this review, ANYWHERE in its findings (not just the first/headline finding), "
        "correctly and specifically identify this bug? A thorough review often finds multiple "
        "issues and ranks them by severity — the planted bug may be item #2 or #3, or folded "
        "into a broader finding, rather than the top-billed item. That still counts as a catch. "
        "It does NOT count if the review only mentions adjacent-sounding concerns without "
        "actually identifying this specific defect. "
        "Score the reviewer's final verdict, not exploratory or retracted hypotheses.\n"
        "Answer with exactly one word: YES or NO."
    )
    verdict = query_judge(judge_prompt, judge_engine=judge_engine, author_engine=author_engine, timeout=90)
    return _parse_judge_verdict(verdict)

def judge_false_positive(review_response: str, *, judge_engine: str = "claude", author_engine: str = "") -> bool:
    """
    Ask a model whether the review claimed to find a bug/defect in a clean, benign diff.
    Scores whether the reviewer's final findings allege an actual defect in the diff itself,
    independent of whether merge approval prose is used.
    """
    judge_prompt = (
        "You are evaluating a code review of a completely correct, benign diff with no bugs.\n\n"
        f"THE REVIEW RESPONSE TO SCORE:\n{review_response}\n\n"
        "Did this review assert or find that the diff itself introduces an actual defect, logic bug, syntax error, regression, or security vulnerability? "
        "Score whether the reviewer's final findings allege an actual defect in the changed code, rather than whether the reviewer explicitly used approval or blocking language. "
        "Do NOT count stylistic notes, documentation observations, UX/a11y tips, or caveats about pre-existing code outside the diff as defect allegations. "
        "Answer NO if the review concludes there are no defects in the diff or describes the diff as sound/correct. "
        "Answer YES only if the reviewer's final findings allege that the changed code itself contains or introduces an actual defect, bug, or vulnerability.\n"
        "Answer with exactly one word: YES or NO."
    )
    verdict = query_judge(judge_prompt, judge_engine=judge_engine, author_engine=author_engine, timeout=90)
    return _parse_judge_verdict(verdict)

def run_benchmark(
    cases_dir: Path = DEFAULT_CASES_DIR,
    engine: str = "auto",
    limit: int = 0,
    case_id: str = "",
    *,
    judge_engine: str = "claude",
    verbose: bool = False
) -> Tuple[int, int, int, int, List[Dict[str, Any]]]:
    """
    Runs the benchmark suite across all case JSONs in cases_dir.
    Returns (bugs_caught, positive_total, false_positives, negative_total, detailed_results).
    """
    case_files = sorted(list(cases_dir.glob("case_*.json")))
    if case_id:
        case_files = [f for f in case_files if case_id in f.stem]

    if not case_files:
        print(f"[Benchmark] No case files found in {cases_dir}")
        return 0, 0, 0, 0, []

    if limit > 0:
        case_files = case_files[:limit]

    total = len(case_files)
    positive_total = 0
    bugs_caught = 0
    negative_total = 0
    false_positives = 0
    results = []

    judge_engine = _keep_claude_as_judge(engine, judge_engine)
    print("================================================================================")
    print(f"TRIAD ADVISORY BENCHMARK HARNESS (engine={engine}, cases={total})")
    print("Scoring: Model-as-Judge verification (No keyword matching)")
    if judge_engine in ("asymmetric", "codex"):
        print("Judge: Codex first (explicit override)")
    else:
        print("Judge: Claude primary, Codex failover")
        print("Judge baseline: Claude primary, same family as the 2026-10-04 scores. Docker scores are separate.")
    print("================================================================================")

    for idx, case_path in enumerate(case_files, 1):
        with open(case_path, "r", encoding="utf-8") as f:
            case = json.load(f)

        cid = case.get("id", case_path.stem)
        expected = case.get("expected_catch", True)
        desc = case.get("bug_description", "")
        diff = case.get("diff", "")

        label = desc[:50] if desc else "[Negative Control - Clean Diff]"
        print(f"[{idx:02d}/{total:02d}] {cid}: {label}...", end=" ", flush=True)

        prompt = (
            "Review this git diff carefully. Identify any bugs, race conditions, type errors, "
            "security vulnerabilities, or unintended regressions. If none exist, state that the diff is sound."
        )

        try:
            # 1. Get raw review from advisory engine
            review = query_advisory_council(
                prompt=prompt,
                diff=diff,
                mode="review_diff",
                engine=engine
            )

            # 2. Judge review response
            if expected:
                positive_total += 1
                is_caught = judge_catch(desc, review, judge_engine=judge_engine, author_engine=engine)
                if is_caught:
                    bugs_caught += 1
                    print("✓ CAUGHT")
                else:
                    print("✗ MISSED")

                results.append({
                    "id": cid,
                    "type": "positive",
                    "description": desc,
                    "caught": is_caught,
                    "review_sample": review[:200]
                })
            else:
                negative_total += 1
                is_fp = judge_false_positive(review, judge_engine=judge_engine, author_engine=engine)
                if is_fp:
                    false_positives += 1
                    print("✗ FALSE POSITIVE")
                else:
                    print("✓ CLEAN PASS")

                results.append({
                    "id": cid,
                    "type": "negative_control",
                    "false_positive": is_fp,
                    "review_sample": review[:200]
                })

            if verbose:
                print(f"\n--- [FULL REVIEW: {cid}] ---\n{review.strip()}\n-------------------------------------------------\n")

        except JudgeUnavailableError as e:
            print(f"✗ JUDGE UNAVAILABLE: {e}")
            print("\n❌ [Benchmark ABORTED] Cannot compute valid score while judging instruments are unavailable.")
            sys.exit(1)
        except Exception as e:
            print(f"ERROR ({e})")
            results.append({
                "id": cid,
                "error": str(e)
            })

    catch_rate = (bugs_caught / positive_total * 100) if positive_total > 0 else 0.0
    fp_rate = (false_positives / negative_total * 100) if negative_total > 0 else 0.0

    print("================================================================================")
    print(f"BENCHMARK RESULT: {bugs_caught}/{positive_total} bugs caught ({catch_rate:.1f}%) | "
          f"{false_positives}/{negative_total} false positives ({fp_rate:.1f}%) | engine={engine} | judge={judge_engine}")
    print("================================================================================\n")

    return bugs_caught, positive_total, false_positives, negative_total, results

def main():
    parser = argparse.ArgumentParser(description="Triad Benchmark Runner")
    parser.add_argument("--cases-dir", default=str(DEFAULT_CASES_DIR), help="Directory of test cases")
    parser.add_argument("--engine", choices=["auto", "claude", "codex"], default="auto", help="Advisor engine")
    parser.add_argument("--judge-engine", choices=["claude", "auto", "codex", "asymmetric"], default="claude", help="Model to use for judging (default: claude, then Codex if Claude cannot answer)")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of cases to run")
    parser.add_argument("--case", default="", help="Run single case ID")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print verbose review output")
    parser.add_argument("--output", default="", help="Save JSON report to file")

    args = parser.parse_args()
    cases_dir = Path(args.cases_dir)
    bugs_caught, pos_tot, fps, neg_tot, results = run_benchmark(
        cases_dir=cases_dir,
        engine=args.engine,
        limit=args.limit,
        case_id=args.case,
        judge_engine=args.judge_engine,
        verbose=args.verbose
    )

    if args.output:
        out_path = Path(args.output)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({
                "bugs_caught": bugs_caught,
                "positive_total": pos_tot,
                "catch_rate": (bugs_caught / pos_tot * 100) if pos_tot > 0 else 0,
                "false_positives": fps,
                "negative_total": neg_tot,
                "false_positive_rate": (fps / neg_tot * 100) if neg_tot > 0 else 0,
                "engine": args.engine,
                "results": results
            }, f, indent=2)
        print(f"Report saved to {out_path}")

    sys.exit(0)

if __name__ == "__main__":
    main()
