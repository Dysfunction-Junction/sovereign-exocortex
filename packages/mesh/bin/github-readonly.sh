#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "github-readonly: Node.js was not found" >&2
  exit 127
fi
if [[ ! -f "${DIR}/dist/mcp-filter-proxy.js" ]]; then
  echo "github-readonly: dist/mcp-filter-proxy.js is missing; run npm run build" >&2
  exit 1
fi
if [[ ! -f "${DIR}/github-readonly-tools.manifest.json" ]]; then
  echo "github-readonly: pinned tool manifest is missing" >&2
  exit 1
fi

# Reviewed 2026-07-12: every upstream tool marked readOnlyHint=true except
# run_secret_scanning, which accepts raw content and is excluded as an egress risk.
# All 19 write-capable tools are recorded in the manifest policy and excluded.
ALLOW_TOOLS="get_commit,get_copilot_job_status,get_file_contents,get_label,get_latest_release,get_me,get_release_by_tag,get_tag,get_team_members,get_teams,issue_read,list_branches,list_commits,list_issue_fields,list_issue_types,list_issues,list_pull_requests,list_releases,list_repository_collaborators,list_tags,pull_request_read,search_code,search_commits,search_issues,search_pull_requests,search_repositories,search_users"

exec "${NODE_BIN}" "${DIR}/dist/mcp-filter-proxy.js" \
  --upstream-url "https://api.githubcopilot.com/mcp/" \
  --allow-tools "${ALLOW_TOOLS}" \
  --manifest "${DIR}/github-readonly-tools.manifest.json" \
  --header-secret "Authorization=${HOME}/.secrets/github_token" \
  --startup-timeout-ms 30000 \
  --call-timeout-ms 300000
