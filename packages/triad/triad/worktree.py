#!/usr/bin/env python3
"""
Autonomous Multi-Agent Triad: Git Worktree Isolation (worktree.py).
Provides high-reliability ephemeral git worktree lifecycle management on Windows:
- create_worktree: allocates an isolated worktree directory from any commit or branch
- remove_worktree: cleans up worktree files, clears Windows read-only locks, and prunes git metadata
- isolated_worktree: safe context manager ensuring automatic rollback & cleanup
"""

import sys
import os
import re
import stat
import shutil
import subprocess
import tempfile
import uuid
import time
import gc
import json
import hashlib
import threading
from pathlib import Path
from contextlib import contextmanager
from typing import Optional, Union, List, Dict, Any, Generator, Tuple


def _remove_readonly(func, path, exc_info):
    """Clear Windows read-only attribute and retry deletion."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception:
        pass


LOCAL_GIT_VARS = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
)


def clean_git_env(extra_env: Optional[Dict[str, str]] = None, *, base_env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """
    Return an environment dictionary sanitized of local Git environment variables.
    If base_env is provided, it is sanitized; otherwise os.environ is sanitized.
    extra_env contains explicit overrides applied after sanitization.
    """
    source = dict(base_env if base_env is not None else os.environ)
    for k in LOCAL_GIT_VARS:
        source.pop(k, None)
    if extra_env:
        source.update(extra_env)
    return source


def get_repo_root(path: Union[str, Path] = ".", env: Optional[Dict[str, str]] = None) -> Path:
    """Resolve the root directory of the enclosing git repository."""
    p = Path(path).resolve()
    target_dir = p.parent if p.is_file() else p
    cmd = ["git", "-C", str(target_dir), "rev-parse", "--show-toplevel"]
    run_env = env if env is not None else clean_git_env()
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)
    if res.returncode != 0:
        raise ValueError(f"'{path}' is not inside a valid git repository: {res.stderr.strip()}")
    return Path(res.stdout.strip()).resolve()


def list_worktrees(repo_path: Optional[Union[str, Path]] = None, env: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """
    List all worktrees registered in the git repository using porcelain output.
    Returns list of dicts:
      [{'worktree': Path, 'head': str, 'branch': str, 'detached': bool, 'bare': bool, 'prunable': bool}, ...]
    """
    repo_path = Path(repo_path).resolve() if repo_path else get_repo_root(".", env=env)
    cmd = ["git", "-C", str(repo_path), "worktree", "list", "--porcelain"]
    run_env = clean_git_env(base_env=env) if env is not None else clean_git_env()
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)
    if res.returncode != 0:
        raise RuntimeError(f"git worktree list failed: {res.stderr.strip()}")

    worktrees = []
    current: Dict[str, Any] = {}

    for line in res.stdout.splitlines():
        line = line.strip()
        if not line:
            if current and "worktree" in current:
                worktrees.append(current)
                current = {}
            continue

        if line.startswith("worktree "):
            wt_path = line[len("worktree "):].strip()
            current["worktree"] = Path(wt_path).resolve()
            current["detached"] = False
            current["bare"] = False
            current["prunable"] = False
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD "):].strip()
        elif line.startswith("branch "):
            current["branch"] = line[len("branch "):].strip()
        elif line == "detached":
            current["detached"] = True
        elif line == "bare":
            current["bare"] = True
        elif line.startswith("prunable"):
            current["prunable"] = True

    if current and "worktree" in current:
        worktrees.append(current)

    return worktrees


def prune_worktrees(repo_path: Optional[Union[str, Path]] = None, env: Optional[Dict[str, str]] = None) -> None:
    """Prune stale administrative worktree metadata."""
    target = Path(repo_path).resolve() if repo_path else get_repo_root(".", env=env)
    run_env = clean_git_env(base_env=env) if env is not None else clean_git_env()
    subprocess.run(
        ["git", "-C", str(target), "worktree", "prune"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=run_env
    )


def _discover_repo_from_worktree(worktree_path: Path) -> Optional[Path]:
    """Inspect .git file in worktree to locate main repository root."""
    git_file = worktree_path / ".git"
    if not git_file.exists() or not git_file.is_file():
        return None

    try:
        content = git_file.read_text(encoding="utf-8", errors="replace").strip()
        if content.startswith("gitdir:"):
            gitdir = content[len("gitdir:"):].strip()
            gitdir_path = Path(gitdir).resolve()
            # Standard path: <repo_root>/.git/worktrees/<name>
            if gitdir_path.parent.name == "worktrees" and gitdir_path.parent.parent.name == ".git":
                return gitdir_path.parent.parent.parent
            # Alternative: <repo_root>/.git/...
            for parent in gitdir_path.parents:
                if (parent / ".git").is_dir() or (parent / "HEAD").is_file():
                    return parent
    except Exception:
        pass

    return None


def create_worktree(
    repo_path: Union[str, Path],
    branch_or_commit: str = "HEAD",
    prefix: str = "triad-work",
    target_path: Optional[Union[str, Path]] = None,
    detach: bool = True,
    env: Optional[Dict[str, str]] = None
) -> Path:
    """
    Create a new isolated git worktree.
    
    Args:
        repo_path: Path to the root of the source git repository.
        branch_or_commit: Git commit SHA, branch name, or tag (default 'HEAD').
        prefix: Prefix for generated temporary worktree directory name.
        target_path: Optional explicit target directory path.
        detach: If True, checks out as detached HEAD to prevent branch collision.
        env: Optional execution environment dict.
        
    Returns:
        Path: Resolved absolute path to the newly created worktree.
    """
    root = get_repo_root(repo_path, env=env)

    if target_path:
        wt_path = Path(target_path).resolve()
    else:
        unique_name = f"{prefix}-{uuid.uuid4().hex[:8]}"
        wt_path = Path(tempfile.gettempdir()) / unique_name

    cmd = ["git", "-C", str(root), "worktree", "add"]
    if detach:
        cmd.append("--detach")
    cmd.extend([str(wt_path), str(branch_or_commit)])

    run_env = clean_git_env(base_env=env) if env is not None else clean_git_env()
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)
    if res.returncode != 0:
        raise RuntimeError(f"Failed to create git worktree at '{wt_path}': {res.stderr.strip() or res.stdout.strip()}")

    # If candidate worktree contains submodules, initialize and check them out
    if (wt_path / ".gitmodules").exists():
        sub_cmd = ["git", "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]
        subprocess.run(sub_cmd, cwd=str(wt_path), capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)

    return wt_path.resolve()


def is_reparse_or_link(path: Union[str, Path]) -> bool:
    """Return True if path is a symlink, Windows directory junction, or reparse point."""
    try:
        p_str = str(path)
        if os.path.islink(p_str):
            return True
        if hasattr(os.path, "isjunction") and os.path.isjunction(p_str):
            return True
        if os.name == "nt":
            st = os.lstat(p_str)
            if hasattr(st, "st_file_attributes") and (st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                return True
    except Exception:
        pass
    return False


def _clean_path(p: Union[str, Path]) -> Path:
    s = str(Path(p).resolve())
    if s.startswith(("\\\\?\\", "//?/")):
        s = s[4:]
    return Path(os.path.normpath(s))


def _get_worktree_admin_dir(worktree_path: Union[str, Path]) -> Optional[Path]:
    """Inspect .git file or directory in worktree to locate its git administrative directory."""
    wt = Path(worktree_path).resolve()
    git_ref = wt / ".git"
    if git_ref.is_file():
        try:
            content = git_ref.read_text(encoding="utf-8", errors="replace").strip()
            if content.startswith("gitdir:"):
                gitdir = content[len("gitdir:"):].strip()
                p = Path(gitdir)
                if not p.is_absolute():
                    p = (wt / p).resolve()
                if p.is_dir():
                    return p
        except Exception:
            pass
    elif git_ref.is_dir():
        return git_ref.resolve()
    return None


def _write_text_no_follow(path: Path, content: str, encoding: str = "utf-8") -> None:
    """
    Write text to `path` without ever following an existing symlink.
    `path` may live in a shared, world-writable directory (e.g. the system temp
    dir) under a name derived from a hash of the worktree path, so it is not
    safe to assume nothing else can have pre-created it as a symlink pointing
    somewhere sensitive. Refuses (raises OSError) rather than writing through
    a symlink.
    """
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(str(path), flags, 0o600)
    try:
        # O_NOFOLLOW only blocks a symlink; it doesn't stop something else
        # from having pre-created a real file at this path in the shared
        # temp directory. On POSIX, refuse to write (and O_TRUNC away the
        # contents of) a file this process doesn't own before truncating it.
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError(f"Refusing to write to non-regular file: {path}")
        if hasattr(os, "geteuid") and st.st_uid != os.geteuid():
            raise OSError(f"Refusing to write to a file owned by another user: {path}")
        os.ftruncate(fd, 0)
        f = os.fdopen(fd, "w", encoding=encoding)
    except BaseException:
        os.close(fd)
        raise
    with f:
        f.write(content)


def _get_provisioned_manifest_path(worktree_path: Union[str, Path]) -> Path:
    """Resolve the location of the provisioned dependency manifest OUTSIDE the worktree checkout."""
    wt = Path(worktree_path).resolve()
    admin_dir = _get_worktree_admin_dir(wt)
    if admin_dir and admin_dir.is_dir():
        return admin_dir / "triad_provisioned_manifest.json"
    h = hashlib.sha256(str(_clean_path(wt)).encode("utf-8")).hexdigest()[:16]
    if not re.fullmatch(r"[0-9a-f]{16}", h):
        raise ValueError("Computed manifest hash was not a well-formed hex digest")
    return Path(tempfile.gettempdir()) / f"triad_provisioned_{h}.json"


def get_provisioned_manifest_entries(worktree_path: Union[str, Path]) -> List[str]:
    """
    Retrieve relative paths of all provisioned dependency entries recorded for this worktree.
    Returns relative paths (e.g. 'node_modules', 'node_modules/lodash', etc.).
    """
    wt = Path(worktree_path).resolve()
    manifest_file = _get_provisioned_manifest_path(wt)
    if not manifest_file.exists():
        old_manifest = wt / ".triad_provisioned_manifest.json"
        if old_manifest.exists():
            manifest_file = old_manifest
        else:
            return []

    entries: List[str] = []
    try:
        data = json.loads(manifest_file.read_text(encoding="utf-8"))
        raw_list = data.get("entries", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
        for item in raw_list:
            if isinstance(item, str):
                p = Path(item)
                try:
                    rel = p.relative_to(wt)
                    entries.append(str(rel).replace("\\", "/"))
                except ValueError:
                    entries.append(item)
    except Exception:
        pass
    return entries


def _resolve_dependency_symlink_target(src: Path, repo_root: Path) -> Tuple[Optional[Path], bool]:
    """
    Inspect symlink target and classify:
    Returns (rel_path, is_workspace_source).
    - If target points inside repo_root but OUTSIDE repo_root/node_modules:
      returns (rel_to_repo_root, True) -> internal workspace source package!
    - If target points inside repo_root/node_modules:
      returns (rel_to_node_modules, False) -> dependency-store target (e.g. .pnpm/...)!
    - If target points outside repo_root entirely:
      returns (None, False) -> external target.
    """
    if is_reparse_or_link(src):
        try:
            raw_target = os.readlink(str(src))
            target_path = Path(raw_target)
            if not target_path.is_absolute():
                target_path = src.parent / target_path
            abs_target = _clean_path(target_path)
            clean_repo = _clean_path(repo_root)
            clean_nm = _clean_path(repo_root / "node_modules")

            # Check if it targets within node_modules (e.g. .pnpm store or hoisted dep)
            try:
                rel_nm = abs_target.relative_to(clean_nm)
                return rel_nm, False
            except ValueError:
                pass

            # Check if it targets within repository source outside node_modules
            try:
                rel_repo = abs_target.relative_to(clean_repo)
                return rel_repo, True
            except ValueError:
                pass
        except (ValueError, OSError):
            pass
    return None, False


def _link_dependency_entry(
    src: Path,
    dst: Path,
    repo_root: Path,
    wt_root: Path,
    wt_nm: Path,
    manifest: Optional[List[str]] = None,
    unresolved: Optional[List[str]] = None
) -> bool:
    """
    Link a single dependency entry, redirecting internal workspace links to candidate worktree,
    and dependency-store links (e.g. .pnpm) to the worktree node_modules.
    Fails closed: if an internal workspace link cannot be retargeted (e.g. candidate deleted it),
    it is NEVER linked to the parent source.
    """
    if is_reparse_or_link(dst) or dst.exists() or is_reparse_or_link(dst.parent):
        return False

    rel_path, is_workspace_source = _resolve_dependency_symlink_target(src, repo_root)

    if is_workspace_source and rel_path is not None:
        # Internal monorepo workspace package! Retarget strictly to candidate worktree
        candidate_target = _lexical_clean_path(wt_root / rel_path)
        if candidate_target.exists():
            if candidate_target.is_dir() and os.name == "nt":
                res = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(dst), str(candidate_target)], capture_output=True, text=True)
                if res.returncode == 0:
                    if manifest is not None:
                        manifest.append(str(dst))
                    return True
            try:
                os.symlink(str(candidate_target), str(dst), target_is_directory=candidate_target.is_dir())
                if manifest is not None:
                    manifest.append(str(dst))
                return True
            except Exception:
                pass
        # Fail closed: internal workspace package target does not exist in candidate worktree (e.g. staged deletion),
        # or symlink creation failed. NEVER fall through to linking parent source!
        if unresolved is not None:
            unresolved.append(f"{dst.name} -> missing workspace package {rel_path}")
        return False

    if (not is_workspace_source) and rel_path is not None:
        # Dependency-store target within node_modules (e.g. .pnpm/store/...)
        candidate_target = _lexical_clean_path(wt_nm / rel_path)
        if candidate_target.exists():
            if candidate_target.is_dir() and os.name == "nt":
                res = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(dst), str(candidate_target)], capture_output=True, text=True)
                if res.returncode == 0:
                    if manifest is not None:
                        manifest.append(str(dst))
                    return True
            try:
                os.symlink(str(candidate_target), str(dst), target_is_directory=candidate_target.is_dir())
                if manifest is not None:
                    manifest.append(str(dst))
                return True
            except Exception:
                pass
        if unresolved is not None:
            unresolved.append(f"{dst.name} -> missing dependency store target {rel_path}")
        return False

    # External dependency: create junction on Windows or symlink on POSIX
    if src.is_dir():
        if os.name == "nt":
            res = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(dst), str(src)], capture_output=True, text=True)
            if res.returncode == 0:
                if manifest is not None:
                    manifest.append(str(dst))
                return True
            try:
                os.symlink(str(src), str(dst), target_is_directory=True)
                if manifest is not None:
                    manifest.append(str(dst))
                return True
            except Exception:
                pass
        else:
            try:
                os.symlink(str(src), str(dst), target_is_directory=True)
                if manifest is not None:
                    manifest.append(str(dst))
                return True
            except Exception:
                pass
    elif src.is_file():
        try:
            shutil.copy2(str(src), str(dst))
            if manifest is not None:
                manifest.append(str(dst))
            return True
        except Exception:
            pass
    return False


def _provision_bin_entry(
    src: Path,
    dst: Path,
    repo_root: Path,
    wt_root: Path,
    wt_nm: Path,
    manifest: List[str],
    unresolved: Optional[List[str]] = None
) -> None:
    """Provision a single executable in node_modules/.bin, ensuring isolation from parent workspace packages."""
    if is_reparse_or_link(dst) or dst.exists() or is_reparse_or_link(dst.parent):
        return

    if is_reparse_or_link(src):
        try:
            rel_path, is_workspace_source = _resolve_dependency_symlink_target(src, repo_root)
            if is_workspace_source and rel_path is not None:
                candidate_target = _lexical_clean_path(wt_root / rel_path)
                if candidate_target.exists():
                    os.symlink(str(candidate_target), str(dst))
                    manifest.append(str(dst))
                else:
                    if unresolved is not None:
                        unresolved.append(f".bin/{dst.name} -> missing workspace package {rel_path}")
                return
            elif (not is_workspace_source) and rel_path is not None:
                candidate_target = _lexical_clean_path(wt_nm / rel_path)
                if candidate_target.exists():
                    os.symlink(str(candidate_target), str(dst))
                    manifest.append(str(dst))
                else:
                    if unresolved is not None:
                        unresolved.append(f".bin/{dst.name} -> missing store executable {rel_path}")
                return
            else:
                raw_target = os.readlink(str(src))
                target_path = Path(raw_target)
                if not target_path.is_absolute():
                    target_path = src.parent / target_path
                abs_target = _clean_path(target_path)
                os.symlink(str(abs_target), str(dst))
                manifest.append(str(dst))
        except Exception:
            if unresolved is not None:
                unresolved.append(f".bin/{dst.name}")
        return

    # Regular file wrapper (.cmd, .ps1, shell script)
    try:
        content_b = src.read_bytes()
        # If the script contains absolute references to repo_root, retarget them to wt_root
        parent_bytes = str(repo_root).encode("utf-8")
        wt_bytes = str(wt_root).encode("utf-8")
        if parent_bytes in content_b:
            content_b = content_b.replace(parent_bytes, wt_bytes)
        parent_fwd = str(repo_root).replace("\\", "/").encode("utf-8")
        wt_fwd = str(wt_root).replace("\\", "/").encode("utf-8")
        if parent_fwd in content_b:
            content_b = content_b.replace(parent_fwd, wt_fwd)
        dst.write_bytes(content_b)
        shutil.copymode(str(src), str(dst))
        manifest.append(str(dst))
    except Exception:
        try:
            shutil.copy2(str(src), str(dst))
            manifest.append(str(dst))
        except Exception:
            pass


def _contains_workspace_symlink(d: Path, repo_root: Path) -> bool:
    """Check if directory tree contains any symlinks pointing to parent workspace outside node_modules."""
    try:
        for root, dirs, files in os.walk(d, followlinks=False):
            for name in list(dirs) + list(files):
                item = Path(root) / name
                if is_reparse_or_link(item):
                    _, is_ws = _resolve_dependency_symlink_target(item, repo_root)
                    if is_ws:
                        return True
    except Exception:
        pass
    return False


def _check_dependency_graph_compatibility(parent_root: Path, wt_root: Path) -> Tuple[bool, Optional[str]]:
    """
    Verify that candidate worktree dependency manifests and lockfiles match the parent installation.
    Prevents certifying candidate code against an obsolete dependency graph.
    """
    manifest_names = [
        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
        "pnpm-workspace.yaml"
    ]
    for name in manifest_names:
        p_file = parent_root / name
        w_file = wt_root / name
        if p_file.exists() and w_file.exists():
            if name == "package.json":
                try:
                    p_data = json.loads(p_file.read_text(encoding="utf-8"))
                    w_data = json.loads(w_file.read_text(encoding="utf-8"))
                    dep_keys = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
                    p_deps = {k: p_data.get(k) for k in dep_keys}
                    w_deps = {k: w_data.get(k) for k in dep_keys}
                    if p_deps != w_deps:
                        return False, "Candidate package.json dependencies differ from parent installation"
                except Exception:
                    if p_file.read_bytes() != w_file.read_bytes():
                        return False, f"Candidate {name} differs from parent"
            else:
                if p_file.read_bytes() != w_file.read_bytes():
                    return False, f"Candidate lockfile {name} differs from parent installation"
        elif p_file.exists() != w_file.exists():
            return False, f"Dependency manifest presence mismatch for {name}"
    return True, None


def _provision_store_directory(
    src_store: Path,
    dst_store: Path,
    repo_root: Path,
    wt_root: Path,
    wt_nm: Path,
    manifest: List[str],
    pending_links: Optional[List[Tuple[Path, Path]]] = None,
    unresolved: Optional[List[str]] = None,
    depth: int = 0
) -> int:
    """
    Recursively provision dependency store directories (.pnpm) in two passes:
    Pass 1: Creates all directory structures and copies regular files, collecting symlinks into pending_links.
    Pass 2: Resolves all symlinks/junctions across created store directories, eliminating enumeration order dependencies.
    """
    if is_reparse_or_link(dst_store) or is_reparse_or_link(dst_store.parent):
        return 0

    is_top_level = (pending_links is None)
    if is_top_level:
        pending_links = []

    count = 0
    dst_store_created = False
    if not dst_store.exists():
        try:
            dst_store.mkdir(parents=True, exist_ok=True)
            dst_store_created = True
        except Exception:
            return 0

    try:
        for item in src_store.iterdir():
            dst_item = dst_store / item.name
            if is_reparse_or_link(dst_item):
                continue
            if is_reparse_or_link(item):
                pending_links.append((item, dst_item))
            elif item.is_dir():
                sub_count = _provision_store_directory(
                    item, dst_item, repo_root, wt_root, wt_nm, manifest,
                    pending_links=pending_links, unresolved=unresolved, depth=depth + 1
                )
                count += sub_count
            elif item.is_file():
                if _link_dependency_entry(item, dst_item, repo_root, wt_root, wt_nm, manifest, unresolved):
                    count += 1
    except Exception:
        pass

    if dst_store_created:
        manifest.append(str(dst_store))

    # Pass 2: At top-level, resolve all pending links once all store directories exist
    if is_top_level and pending_links:
        for src_item, dst_item in pending_links:
            if _link_dependency_entry(src_item, dst_item, repo_root, wt_root, wt_nm, manifest, unresolved):
                count += 1

    return count


def provision_worktree_dependencies(repo_root: Union[str, Path], worktree_path: Union[str, Path]) -> List[str]:
    """
    Provision external non-tracked dependency directories (such as node_modules)
    from parent repository into isolated worktree via fine-grained zero-copy links.
    Internal workspace package links are strictly retargeted to candidate worktree directories,
    ensuring candidate isolation is never broken by parent unstaged changes.
    Tracks all created entries in a manifest outside the candidate tree for safe, non-traversing deprovisioning.
    Provisions dependency stores (.pnpm) first, packages second, and executables (.bin) last.
    """
    provisioned = []
    root = Path(repo_root).resolve()
    wt = Path(worktree_path).resolve()

    # Check dependency graph compatibility between parent and candidate
    compat, reason = _check_dependency_graph_compatibility(root, wt)
    if not compat:
        print(f"\n❌ [Triad Worktree Error] Cannot reuse parent dependencies: {reason}", file=sys.stderr)
        raise RuntimeError(f"Dependency graph mismatch: {reason}. Run package manager install to update dependencies.")

    parent_nm = root / "node_modules"
    wt_nm = wt / "node_modules"
    manifest: List[str] = []
    unresolved: List[str] = []

    if parent_nm.is_dir() and not is_reparse_or_link(parent_nm):
        # Reject if destination node_modules is already a reparse point or symlink
        if is_reparse_or_link(wt_nm):
            print(f"[Triad Worktree Warning] Worktree node_modules is a reparse point or link: {wt_nm}", file=sys.stderr)
            return provisioned

        wt_nm_created = False
        if not wt_nm.exists():
            try:
                wt_nm.mkdir(parents=True, exist_ok=True)
                wt_nm_created = True
            except Exception:
                return provisioned

        count = 0
        try:
            # Categorize parent node_modules entries
            items = list(parent_nm.iterdir())
            store_dirs: List[Path] = []
            package_dirs: List[Path] = []
            package_links: List[Path] = []
            bin_dir: Optional[Path] = None

            for item in items:
                if item.name == ".bin":
                    bin_dir = item
                elif item.name.startswith(".") and item.is_dir() and not is_reparse_or_link(item):
                    # Dependency stores like .pnpm, .store, etc.
                    store_dirs.append(item)
                elif item.name.startswith("@") and item.is_dir() and not is_reparse_or_link(item):
                    package_dirs.append(item)
                elif item.is_dir() and not is_reparse_or_link(item):
                    package_dirs.append(item)
                else:
                    package_links.append(item)

            # Phase 1: Provision dependency stores first (.pnpm, etc.)
            for store in store_dirs:
                dst_store = wt_nm / store.name
                count += _provision_store_directory(store, dst_store, root, wt, wt_nm, manifest, unresolved=unresolved)

            # Phase 2: Provision package directories and scope directories
            for item in package_dirs:
                if item.name.startswith("@"):
                    wt_scope = wt_nm / item.name
                    if is_reparse_or_link(wt_scope):
                        continue
                    wt_scope_created = False
                    if not wt_scope.exists():
                        try:
                            wt_scope.mkdir(parents=True, exist_ok=True)
                            wt_scope_created = True
                        except Exception:
                            continue
                    for sub_item in item.iterdir():
                        if _contains_workspace_symlink(sub_item, root):
                            count += _provision_store_directory(sub_item, wt_scope / sub_item.name, root, wt, wt_nm, manifest, unresolved=unresolved)
                        elif _link_dependency_entry(sub_item, wt_scope / sub_item.name, root, wt, wt_nm, manifest, unresolved):
                            count += 1
                    if wt_scope_created:
                        manifest.append(str(wt_scope))
                else:
                    if _contains_workspace_symlink(item, root):
                        count += _provision_store_directory(item, wt_nm / item.name, root, wt, wt_nm, manifest, unresolved=unresolved)
                    elif _link_dependency_entry(item, wt_nm / item.name, root, wt, wt_nm, manifest, unresolved):
                        count += 1

            # Phase 3: Provision package-level symlinks / files
            for item in package_links:
                if _link_dependency_entry(item, wt_nm / item.name, root, wt, wt_nm, manifest, unresolved):
                    count += 1

            # Phase 4: Provision executables (.bin) last
            if bin_dir is not None and bin_dir.is_dir():
                wt_bin = wt_nm / ".bin"
                if not is_reparse_or_link(wt_bin):
                    wt_bin_created = False
                    if not wt_bin.exists():
                        try:
                            wt_bin.mkdir(parents=True, exist_ok=True)
                            wt_bin_created = True
                        except Exception:
                            pass
                    for bin_item in bin_dir.iterdir():
                        _provision_bin_entry(bin_item, wt_bin / bin_item.name, root, wt, wt_nm, manifest, unresolved)
                    if wt_bin_created:
                        manifest.append(str(wt_bin))

            if wt_nm_created:
                manifest.append(str(wt_nm))
            if count > 0:
                provisioned.append(f"node_modules ({count} isolated packages)")
            if unresolved:
                store_unresolved = [u for u in unresolved if "missing dependency store target" in u]
                if store_unresolved:
                    err_msg = ", ".join(store_unresolved[:5])
                    print(f"❌ [Triad Worktree Error] Unresolved required dependency links in store: {err_msg}", file=sys.stderr)
                    deprovision_worktree_dependencies(wt)
                    raise RuntimeError(f"Failed to provision dependencies: unresolved required links: {err_msg}")
                else:
                    print(f"[Triad Worktree Warning] Unresolved dependency links in candidate tree: {', '.join(unresolved[:5])}", file=sys.stderr)
        except Exception as e:
            if isinstance(e, RuntimeError):
                raise
            pass

    # Persist tracking manifest OUTSIDE the worktree checkout
    if manifest:
        try:
            manifest_file = _get_provisioned_manifest_path(wt)
            manifest_file.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "version": 1,
                "worktree": str(_clean_path(wt)),
                "entries": manifest
            }
            _write_text_no_follow(manifest_file, json.dumps(manifest_payload, indent=2))
        except Exception:
            pass

    return provisioned


def _lexical_clean_path(p: Union[str, Path]) -> Path:
    """Normalize path lexically without resolving symlinks or reparse points."""
    s = os.path.abspath(os.path.normpath(str(p)))
    if s.startswith(("\\\\?\\", "//?/")):
        s = s[4:]
    return Path(s)


def deprovision_worktree_dependencies(worktree_path: Union[str, Path]) -> None:
    """
    Safely unlink provisioned dependency junctions/symlinks before worktree teardown.
    Validates manifest schema and strictly enforces lexical containment:
    Every entry must be lexically contained within the worktree dependency folder,
    with no traversal through linked ancestors. Never touches files outside worktree.
    """
    wt = Path(worktree_path).resolve()
    clean_wt = _lexical_clean_path(wt)
    clean_nm = _lexical_clean_path(wt / "node_modules")

    # Locate manifest outside checkout
    manifest_file = _get_provisioned_manifest_path(wt)
    old_manifest_file = wt / ".triad_provisioned_manifest.json"

    target_manifest = manifest_file if manifest_file.exists() else (old_manifest_file if old_manifest_file.exists() else None)

    if target_manifest and target_manifest.exists():
        try:
            raw_data = json.loads(target_manifest.read_text(encoding="utf-8"))
            entries: List[str] = []
            if isinstance(raw_data, dict):
                # Validate schema
                if raw_data.get("version") == 1 and isinstance(raw_data.get("entries"), list):
                    stored_wt = raw_data.get("worktree")
                    if stored_wt and _lexical_clean_path(stored_wt) != clean_wt:
                        # Manifest worktree mismatch: untrusted manifest, abort processing it
                        entries = []
                    else:
                        entries = raw_data["entries"]
            elif isinstance(raw_data, list):
                entries = raw_data

            # Filter and strictly validate lexical containment of every entry
            validated_entries: List[Path] = []
            for entry_str in entries:
                if not isinstance(entry_str, str):
                    continue
                p = Path(entry_str)
                clean_p = _lexical_clean_path(p)

                # Strict lexical containment check: must be inside wt / node_modules
                if not (clean_p == clean_nm or clean_nm in clean_p.parents):
                    # Entry escapes provisioned dependency folder: ignore!
                    continue
                if clean_wt not in clean_p.parents:
                    # Entry escapes worktree: ignore!
                    continue

                # Verify no ancestor between clean_wt and p (exclusive) is a link escaping wt
                cur_parent = _lexical_clean_path(p.parent)
                has_escaping_ancestor = False
                while cur_parent != clean_wt and cur_parent != cur_parent.parent:
                    if is_reparse_or_link(cur_parent):
                        # Symlink ancestor inside checkout (including clean_nm): reject
                        has_escaping_ancestor = True
                        break
                    cur_parent = cur_parent.parent
                if has_escaping_ancestor:
                    continue

                if is_reparse_or_link(p) or p.exists():
                    validated_entries.append(p)

            # Remove deepest paths first
            validated_entries.sort(key=lambda p: len(p.parts), reverse=True)
            for p in validated_entries:
                try:
                    clean_p = _lexical_clean_path(p)
                    # Recheck containment immediately before removal
                    if not (clean_p == clean_nm or clean_nm in clean_p.parents):
                        continue
                    if clean_wt not in clean_p.parents:
                        continue
                    cur_parent = _lexical_clean_path(p.parent)
                    has_linked_ancestor = False
                    while cur_parent != clean_wt and cur_parent != cur_parent.parent:
                        if is_reparse_or_link(cur_parent):
                            has_linked_ancestor = True
                            break
                        cur_parent = cur_parent.parent
                    if has_linked_ancestor:
                        continue

                    if is_reparse_or_link(p):
                        if os.name == "nt" and os.path.isdir(str(p)):
                            try:
                                os.rmdir(str(p))
                            except OSError:
                                subprocess.run(["cmd.exe", "/c", "rmdir", str(p)], capture_output=True)
                        else:
                            p.unlink(missing_ok=True)
                    elif p.is_file():
                        p.unlink(missing_ok=True)
                    elif p.is_dir():
                        try:
                            os.rmdir(str(p))
                        except Exception:
                            pass
                except Exception:
                    pass

            target_manifest.unlink(missing_ok=True)
            return
        except Exception:
            pass


def capture_directory_snapshot(dir_path: Union[str, Path]) -> Optional[Dict[str, Tuple[int, int]]]:
    """
    Recursively snapshot a directory tree's files and subdirectories (size, mtime_ns),
    without following symlinks, to detect any in-place mutation deep within dependency stores.
    Returns None if directory does not exist or is a reparse point / symlink.
    """
    p = Path(dir_path).resolve()
    if not p.exists() or is_reparse_or_link(p):
        return None

    snapshot: Dict[str, Tuple[int, int]] = {}
    try:
        try:
            st = p.stat(follow_symlinks=False)
            snapshot["."] = (st.st_size, st.st_mtime_ns)
        except Exception:
            pass

        for root, dirs, files in os.walk(p, followlinks=False):
            rel_root = Path(root).relative_to(p)
            for d in dirs:
                full_d = Path(root) / d
                try:
                    st = full_d.stat(follow_symlinks=False)
                    snapshot[str(rel_root / d)] = (st.st_size, st.st_mtime_ns)
                except Exception:
                    pass
            for f in files:
                full_f = Path(root) / f
                try:
                    st = full_f.stat(follow_symlinks=False)
                    snapshot[str(rel_root / f)] = (st.st_size, st.st_mtime_ns)
                except Exception:
                    pass
    except Exception:
        pass
    return snapshot


def remove_worktree(
    worktree_path: Union[str, Path],
    force: bool = True,
    repo_path: Optional[Union[str, Path]] = None,
    retries: int = 5,
    retry_delay: float = 0.2,
    env: Optional[Dict[str, str]] = None
) -> bool:
    """
    Safely remove a git worktree and clean up all metadata, handling Windows file locks.
    
    Args:
        worktree_path: Path to the worktree to remove.
        force: Force removal even if there are uncommitted modifications.
        repo_path: Path to the main git repo. If None, attempts auto-discovery.
        retries: Number of deletion retries for locked files on Windows.
        retry_delay: Delay in seconds between retries.
        env: Optional execution environment dict.
        
    Returns:
        bool: True if worktree was successfully removed and unlinked.
    """
    wt_path = Path(worktree_path).resolve()

    # Determine main repository path
    main_repo = Path(repo_path).resolve() if repo_path else _discover_repo_from_worktree(wt_path)
    if not main_repo:
        try:
            main_repo = get_repo_root(".", env=env)
        except Exception:
            main_repo = None

    # Protect against locked CWD on Windows
    try:
        current_cwd = Path.cwd().resolve()
        if current_cwd == wt_path or wt_path in current_cwd.parents:
            safe_cwd = main_repo if (main_repo and main_repo.exists()) else Path(tempfile.gettempdir())
            os.chdir(safe_cwd)
    except Exception:
        pass

    # Collect garbage to release any unclosed file handles in Python
    gc.collect()

    run_env = clean_git_env(base_env=env) if env is not None else clean_git_env()

    if not force:
        # Check if git allows worktree removal before any deprovisioning or deleting
        if main_repo and main_repo.exists():
            cmd = ["git", "-C", str(main_repo), "worktree", "remove", str(wt_path)]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)
            if res.returncode != 0:
                # Git refused removal (worktree contains untracked or modified files)
                # Retain worktree and preserve dependencies intact!
                return False
            # Git successfully removed worktree
            deprovision_worktree_dependencies(wt_path)
            prune_worktrees(main_repo, env=env)
            return True
        else:
            return False

    # Force removal: Safely deprovision external dependency links before unlinking or deleting worktree
    deprovision_worktree_dependencies(wt_path)

    # Execute git worktree remove --force
    if main_repo and main_repo.exists():
        cmd = ["git", "-C", str(main_repo), "worktree", "remove", "--force", str(wt_path)]
        subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env)

    # If directory still persists on disk, recursively delete with read-only handler
    if wt_path.exists():
        deprovision_worktree_dependencies(wt_path)
        for attempt in range(retries):
            try:
                gc.collect()
                shutil.rmtree(wt_path, onerror=_remove_readonly)
                break
            except Exception:
                if attempt < retries - 1:
                    time.sleep(retry_delay * (attempt + 1))

    # Prune git internal worktree tracking
    if main_repo and main_repo.exists():
        prune_worktrees(main_repo, env=env)

    return not wt_path.exists()


@contextmanager
def isolated_worktree(
    repo_path: Union[str, Path],
    branch_or_commit: str = "HEAD",
    prefix: str = "triad-work",
    keep_worktree: bool = False,
    cd: bool = False,
    env: Optional[Dict[str, str]] = None,
    **kwargs
) -> Generator[Path, None, None]:
    """
    Context manager creating an ephemeral git worktree, guaranteed to clean up on exit.
    
    Args:
        repo_path: Root of the source git repository.
        branch_or_commit: Commit SHA, branch, or tag to branch from (default 'HEAD').
        prefix: Directory name prefix.
        keep_worktree: If True, preserves the worktree directory and git linkage on exit.
        cd: If True, temporarily switches current working directory to worktree.
        env: Optional execution environment dict.
    
    Yields:
        Path: The isolated worktree directory path.
    """
    root = get_repo_root(repo_path, env=env)
    wt_path = create_worktree(root, branch_or_commit=branch_or_commit, prefix=prefix, env=env, **kwargs)

    old_cwd = None
    if cd:
        old_cwd = Path.cwd()
        os.chdir(wt_path)

    try:
        yield wt_path
    finally:
        if old_cwd:
            try:
                os.chdir(old_cwd)
            except Exception:
                pass

        if not keep_worktree:
            remove_worktree(wt_path, force=True, repo_path=root, env=env)


def require_git_toplevel(wt: Path, env: Optional[Dict[str, str]] = None) -> None:
    """Refuse reset/clean unless this directory is its own git root.

    If ``.git`` is missing, ``git -C`` walks up and can clean a parent repo.
    """
    try:
        probe = subprocess.run(
            ["git", "-C", str(wt), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=20,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{wt} git toplevel probe timed out; refusing reset/clean") from exc
    if probe.returncode != 0 or not probe.stdout.strip():
        raise RuntimeError(f"{wt} is not a git worktree; refusing reset/clean")
    top = Path(probe.stdout.strip()).resolve()
    here = Path(wt).resolve()
    if os.path.normcase(str(top)) != os.path.normcase(str(here)):
        raise RuntimeError(f"{wt} is not its own git toplevel ({top}); refusing reset/clean")


class WarmWorktreePool:
    """
    Managed pool of recycled git worktrees for high-throughput batch evaluation.

    Invariants:
    1. Bounded concurrency: max_workers <= 2 (strictly enforcing triad operating limits).
    2. Zero disk thrashing: worktrees are created ONCE and recycled via fast checkout/clean.
    3. Thread-safe condition-variable resource management: supports arbitrary waiter count.
    4. Safe cleanup: all pool worktrees are unlinked and pruned on close; leased worktrees
       are retained until their active lease releases, preventing file-handle destruction.
    """

    def __init__(
        self,
        repo_path: Optional[Union[str, Path]] = None,
        max_workers: int = 2,
        prefix: str = "triad-warm-wt",
        base_commit: str = "HEAD",
        env: Optional[Dict[str, str]] = None,
        *,
        repo_root: Optional[Union[str, Path]] = None
    ):
        target_root = repo_root or repo_path or "."
        self.repo_root = get_repo_root(target_root, env=env)
        # Non-negotiable #2: never exceed 2 concurrent sessions
        self.max_workers = max(1, min(int(max_workers), 2))
        self.prefix = prefix
        self.env = env
        self._pool_id = uuid.uuid4().hex[:8]

        # Determine exact commit SHA to reset to
        res = subprocess.run(
            ["git", "-C", str(self.repo_root), "rev-parse", base_commit],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=self.env
        )
        if res.returncode != 0 or not res.stdout.strip():
            raise RuntimeError(f"Failed to resolve base_commit '{base_commit}' in {self.repo_root}: {res.stderr.strip()}")
        self.base_sha = res.stdout.strip()

        self._available: List[Path] = []
        self._all_worktrees: List[Path] = []
        self._leased_worktrees: set = set()
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._active_leases = 0
        self._closed = False
        self._created_count = 0

    def _create_single_worktree(self) -> Path:
        idx = self._created_count
        self._created_count += 1
        target_dir = Path(tempfile.gettempdir()) / f"{self.prefix}-{os.getpid()}-{self._pool_id}-{idx}"
        if target_dir.exists():
            remove_worktree(target_dir, force=True, repo_path=self.repo_root, env=self.env)
        wt = create_worktree(
            self.repo_root,
            branch_or_commit=self.base_sha,
            target_path=target_dir,
            detach=True,
            env=self.env
        )
        return wt

    def prewarm(self) -> None:
        """Pre-provisions up to max_workers worktrees."""
        with self._cv:
            if self._closed:
                raise RuntimeError("WarmWorktreePool is closed")
            while len(self._all_worktrees) < self.max_workers:
                wt = self._create_single_worktree()
                self._all_worktrees.append(wt)
                self._available.append(wt)
            self._cv.notify_all()

    @contextmanager
    def acquire(self, timeout: Optional[float] = None) -> Generator[Path, None, None]:
        """
        Acquire a warm, clean worktree from the pool.
        Automatically resets and returns the worktree on context exit.
        """
        start_time = time.monotonic()
        with self._cv:
            while True:
                if self._closed:
                    raise RuntimeError("WarmWorktreePool is closed")
                if self._available:
                    wt = self._available.pop()
                    self._active_leases += 1
                    self._leased_worktrees.add(wt)
                    break
                if len(self._all_worktrees) < self.max_workers:
                    wt = self._create_single_worktree()
                    self._all_worktrees.append(wt)
                    self._active_leases += 1
                    self._leased_worktrees.add(wt)
                    break

                if timeout is not None:
                    elapsed = time.monotonic() - start_time
                    remaining = timeout - elapsed
                    if remaining <= 0:
                        raise TimeoutError("Timed out waiting for available worktree from pool")
                    if not self._cv.wait(timeout=remaining):
                        raise TimeoutError("Timed out waiting for available worktree from pool")
                else:
                    self._cv.wait()

        active_wt = wt
        usable = False
        try:
            active_wt = self._safe_reset_or_replace(active_wt)
            usable = True
            yield active_wt
        finally:
            return_wt = None
            try:
                # A closed pool only needs the tree removed. Resetting here can
                # raise and hide the caller's result.
                if usable and not self._closed:
                    return_wt = self._safe_reset_or_replace(active_wt)
            finally:
                with self._cv:
                    self._active_leases -= 1
                    # A failed return-reset replaces active_wt. Drop every path this lease owned,
                    # otherwise the replacement stays marked leased while also sitting in _available.
                    owned = {active_wt}
                    if return_wt is not None:
                        owned.add(return_wt)
                    for path in owned:
                        self._leased_worktrees.discard(path)
                    if self._closed:
                        for path in owned:
                            try:
                                remove_worktree(path, force=True, repo_path=self.repo_root, env=self.env)
                            except Exception:
                                pass
                            if path in self._all_worktrees:
                                self._all_worktrees.remove(path)
                            if path in self._available:
                                self._available.remove(path)
                        if not self._leased_worktrees:
                            self._available.clear()
                            prune_worktrees(self.repo_root, env=self.env)
                    elif return_wt is not None and return_wt in self._all_worktrees and return_wt not in self._available:
                        self._available.append(return_wt)
                    self._cv.notify_all()

    def _reset_worktree(self, wt: Path) -> None:
        """
        Rapidly resets the warm worktree without filesystem deletion:
        1. Discard uncommitted/staged changes and switch detached HEAD to base commit
        2. Clean all untracked, untracked ignored files and directories (-ffdx)
        Validates return codes of all commands and raises RuntimeError on any failure.
        """
        # Drop dependency junctions before git clean -ffdx. A failure must raise
        # so the pool quarantines this tree instead of cleaning through a link.
        deprovision_worktree_dependencies(wt)
        run_env = clean_git_env(base_env=self.env) if self.env is not None else clean_git_env()
        require_git_toplevel(wt, env=run_env)
        r0 = subprocess.run(["git", "-C", str(wt), "reset", "--hard", "-q"], capture_output=True, env=run_env, timeout=20)
        if r0.returncode != 0:
            raise RuntimeError(f"git reset --hard failed on {wt}: {r0.stderr.decode('utf-8', errors='replace').strip()}")

        r1 = subprocess.run(
            ["git", "-C", str(wt), "checkout", "-f", "--detach", self.base_sha],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env, timeout=20
        )
        if r1.returncode != 0:
            r1_fb = subprocess.run(["git", "-C", str(wt), "reset", "--hard", self.base_sha], capture_output=True, env=run_env, timeout=20)
            if r1_fb.returncode != 0:
                raise RuntimeError(f"git checkout/reset to {self.base_sha} failed on {wt}: {r1.stderr.strip()}")

        r2 = subprocess.run(
            ["git", "-C", str(wt), "clean", "-ffdx"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=run_env, timeout=20
        )
        if r2.returncode != 0:
            raise RuntimeError(f"git clean -ffdx failed on {wt}: {r2.stderr.strip()[:200]}")

    def _safe_reset_or_replace(self, wt: Path) -> Path:
        """
        Attempt to reset worktree. If reset fails or worktree is corrupted,
        quarantine and remove it, creating a fresh replacement.
        """
        try:
            self._reset_worktree(wt)
            return wt
        except Exception:
            with self._cv:
                try:
                    remove_worktree(wt, force=True, repo_path=self.repo_root, env=self.env)
                except Exception:
                    pass
                if wt in self._all_worktrees:
                    self._all_worktrees.remove(wt)
                self._leased_worktrees.discard(wt)

                if not self._closed:
                    replacement = self._create_single_worktree()
                    self._all_worktrees.append(replacement)
                    self._leased_worktrees.add(replacement)
                    return replacement
            raise

    def close(self, timeout: float = 30.0) -> None:
        """Tear down unleased warm worktrees and prune git metadata after active leases drain."""
        with self._cv:
            if self._closed:
                return
            self._closed = True
            self._cv.notify_all()

            # Wait for active leases to finish
            start_time = time.monotonic()
            while self._active_leases > 0:
                remaining = timeout - (time.monotonic() - start_time)
                if remaining <= 0:
                    break
                self._cv.wait(timeout=remaining)

            # Clean up all unleased worktrees immediately
            unleased = [w for w in list(self._all_worktrees) if w not in self._leased_worktrees]
            for wt in unleased:
                try:
                    remove_worktree(wt, force=True, repo_path=self.repo_root, env=self.env)
                except Exception:
                    pass
                if wt in self._all_worktrees:
                    self._all_worktrees.remove(wt)
                if wt in self._available:
                    self._available.remove(wt)

            if not self._leased_worktrees:
                self._all_worktrees.clear()
                self._available.clear()
                prune_worktrees(self.repo_root, env=self.env)

    def __enter__(self):
        self.prewarm()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

