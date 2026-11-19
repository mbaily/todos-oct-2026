#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Non-interactive shells may otherwise select the system's older Node version.
todo_nvm_dir="${NVM_DIR:-${HOME}/.nvm}"
if [[ -s "$todo_nvm_dir/nvm.sh" ]]; then
  set +u
  source "$todo_nvm_dir/nvm.sh" --no-use
  nvm use --silent
  set -u
fi

if ! command -v node >/dev/null || ! node -e 'process.exit(process.versions.node.split(".")[0] === "24" ? 0 : 1)'; then
  printf '%s\n' 'Node 24 is required. Run nvm install, or put Node 24 on your PATH.' >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm ci --include=dev
fi

npm run build
exec node server.js "$@"
