#!/usr/bin/env bash
set -euo pipefail

while [[ "$#" -gt 0 && "$1" != "--" ]]; do
  assignment="$1"
  shift
  name="${assignment%%=*}"
  secret_file="${assignment#*=}"
  if [[ ! "${name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "${secret_file}" == "${assignment}" ]]; then
    echo "secret-env-launch: expected ENV_NAME=/absolute/secret/file" >&2
    exit 2
  fi
  if [[ "${secret_file}" != "${HOME}/.secrets/"* || ! -f "${secret_file}" ]]; then
    echo "secret-env-launch: refusing secret path outside ~/.secrets or missing file" >&2
    exit 2
  fi
  value="$(<"${secret_file}")"
  if [[ -z "${value}" ]]; then
    echo "secret-env-launch: secret file is empty: ${secret_file}" >&2
    exit 2
  fi
  export "${name}=${value}"
done

if [[ "$#" -eq 0 || "$1" != "--" ]]; then
  echo "secret-env-launch: missing -- command separator" >&2
  exit 2
fi
shift
if [[ "$#" -eq 0 ]]; then
  echo "secret-env-launch: missing command" >&2
  exit 2
fi

exec "$@"
