#!/usr/bin/env bash
# Requires a supported Node/npm already on PATH. No source checkout is changed.
# SOURCE_FRAMEWORK=1 permits only the documented unpublished-framework fallback.
# Usage: SOURCE_FRAMEWORK=1 bash docs/research/inline-hardening-validate.sh [ref]
set -euo pipefail
export npm_config_engine_strict=true
source_repo=$(git rev-parse --show-toplevel)
source_ref=${1:-HEAD}
validation_root=$(mktemp -d /tmp/komodo-inline-validation.XXXXXX)
mkdir "$validation_root/app" "$validation_root/evidence"
git -C "$source_repo" archive "$source_ref" | tar -x -C "$validation_root/app"
cd "$validation_root/app"
node --version > "$validation_root/evidence/runtime.txt"
npm --version >> "$validation_root/evidence/runtime.txt"
if npm ci > "$validation_root/evidence/exact-ci.log" 2>&1; then
  echo "Using the unchanged published lockfile"
else
  if [[ ${SOURCE_FRAMEWORK:-0} != 1 ]] || ! rg -q '404.*mcp-server-framework-1\.3\.0\.tgz' "$validation_root/evidence/exact-ci.log"; then
    echo "Exact installation failed; inspect $validation_root/evidence/exact-ci.log" >&2
    exit 1
  fi
  git clone https://github.com/MP-Tool/MCP-Server-Framework.git "$validation_root/framework"
  git -C "$validation_root/framework" checkout --detach 706db031cc19c0ec246c078c216e904343690b67
  (
    cd "$validation_root/framework"
    npm ci > "$validation_root/evidence/framework-ci.log" 2>&1
    npm run build > "$validation_root/evidence/framework-build.log" 2>&1
    npm pack --ignore-scripts > "$validation_root/evidence/framework-pack.log" 2>&1
  )
  cp package-lock.json "$validation_root/original-lock.json"
  trap 'cp "$validation_root/original-lock.json" "$validation_root/app/package-lock.json"' EXIT
  node --input-type=module - "$validation_root/framework/mcp-server-framework-1.3.0.tgz" <<'JS'
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.packages["node_modules/mcp-server-framework"].resolved = pathToFileURL(process.argv[2]).href;
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
JS
  npm ci > "$validation_root/evidence/substitution-ci.log" 2>&1
  cp "$validation_root/original-lock.json" package-lock.json
  echo "Using pinned source-built framework in disposable directory only"
fi
failed=0
for check in test typecheck build build:prod lint format:check test:e2e; do
  if npm run "$check" > "$validation_root/evidence/${check//:/-}.log" 2>&1; then
    echo "$check PASS"
  else
    echo "$check FAIL"
    failed=1
  fi
done
if MCP_SCRUB_ENABLED=false npm test > "$validation_root/evidence/test-framework-scrub-disabled.log" 2>&1; then
  echo "framework scrub disabled test PASS"
else
  failed=1
fi
if [[ -f docs/research/inline-hardening-benchmark.mjs ]]; then
  node docs/research/inline-hardening-benchmark.mjs > "$validation_root/evidence/benchmark.json"
  if ! node docs/research/inline-hardening-repro.mjs > "$validation_root/evidence/toml-repro.json"; then
    echo "TOML security reproduction FAIL (inspect inherited disclosure evidence)"
    failed=1
  fi
  if ! node docs/research/inline-hardening-category-repro.mjs > "$validation_root/evidence/category-repro.json"; then
    echo "Category typo reproduction FAIL (separate upstream PR #251)"
    failed=1
  fi
fi
echo "Evidence: $validation_root/evidence (exit 1 includes the known missing upstream e2e entrypoint)"
exit "$failed"
