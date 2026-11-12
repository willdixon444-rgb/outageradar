#!/usr/bin/env bash
# OutageRadar release preflight. Run from the repo root:
#
#   bash tools/preflight.sh            checks 1-5 here
#   bash tools/preflight.sh 1.18.3     checks 1-5, then builds
#                                      ../outageradar-v1_18_3.zip (next to the
#                                      repo folder, never inside it), unzips it
#                                      into a fresh folder and re-runs 1-5 there
#
# 1. python3 -m py_compile on every .py
# 2. node --check on every .js / .mjs (each checked as a module and as a script)
# 3. ASCII only: everything under site/ (except .png) and every .js/.mjs/.py/.sh
# 4. worker and web-tests test suites, 0 failures
# 5. node tools/status-pages.mjs leaves site/status, site/errors, site/alerts unchanged
# 6. (with a version) zip from git ls-files -co --exclude-standard, minus
#    __pycache__/.pyc/node_modules; unzip, git init, re-run 1-5 from the copy
#
# Stops at the first failure and prints FAIL. Nothing is pushed or deployed.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ -f tools/status-pages.mjs ] && [ -d site ] || fail "run this from the repo root"
command -v node >/dev/null || fail "node is not installed"
command -v python3 >/dev/null || fail "python3 is not installed"
command -v git >/dev/null || fail "git is not installed"

# Project files only (tracked + new, not ignored), never caches or packages.
list_files() {
  git ls-files -co --exclude-standard \
    | grep -v -E '(^|/)(__pycache__|node_modules)(/|$)|\.pyc$' \
    | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done \
    | sort
}

# node --check on a .js file that uses export/import (as our site scripts do)
# can exit 0 even with a syntax error (seen on Node 22). So check every file as
# a module (.mjs copy) and, if that fails, as a plain script (.cjs copy). A real
# syntax error fails both; a valid file passes one.
js_syntax_ok() {
  local t rc=1
  t="$(mktemp -d)"
  cp "$1" "$t/f.mjs"
  if node --check "$t/f.mjs" 2>/dev/null; then rc=0
  else cp "$1" "$t/f.cjs"; node --check "$t/f.cjs" 2>/dev/null && rc=0
  fi
  rm -rf "$t"
  return "$rc"
}
js_syntax_report() {
  local t; t="$(mktemp -d)"; cp "$1" "$t/f.mjs"
  node --check "$t/f.mjs" 2>&1 | sed "s#$t/f.mjs#$1#" | head -6 >&2 || true
  rm -rf "$t"
}

checks() {
  local files
  files="$(list_files)"
  [ -n "$files" ] || fail "no project files found (is this a git folder?)"

  step "1. py_compile"
  local n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    python3 -m py_compile "$f" || fail "py_compile $f"
    n=$((n + 1))
  done < <(printf '%s\n' "$files" | grep -E '\.py$' || true)
  [ "$n" -gt 0 ] || fail "no .py files found"
  echo "ok: $n Python files"
  # py_compile writes caches; keep them out of the folder and the zip.
  find . -name __pycache__ -type d -prune -exec rm -rf {} +

  step "2. node --check"
  n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    js_syntax_ok "$f" || { js_syntax_report "$f"; fail "node --check $f"; }
    n=$((n + 1))
  done < <(printf '%s\n' "$files" | grep -E '\.(js|mjs)$' || true)
  [ "$n" -gt 0 ] || fail "no .js/.mjs files found"
  echo "ok: $n JavaScript files"

  step "3. ASCII check"
  printf '%s\n' "$files" \
    | grep -E '^site/|\.(js|mjs|py|sh)$' \
    | grep -v -E '\.png$' \
    | python3 -c '
import sys
bad, n = [], 0
for name in (l.strip() for l in sys.stdin):
    if not name:
        continue
    n += 1
    data = open(name, "rb").read()
    for i, b in enumerate(data):
        if b > 127:
            line = data.count(b"\n", 0, i) + 1
            bad.append("%s line %d (byte 0x%02x)" % (name, line, b))
            break
if bad:
    print("non-ASCII in:\n  " + "\n  ".join(bad))
    sys.exit(1)
print("ok: %d files are pure ASCII" % n)
' || fail "ASCII check"

  step "4. tests"
  local out
  for suite in worker web-tests; do
    out="$(cd "$suite" && npm test 2>&1)" || { echo "$out" | grep -E '^not ok' >&2 || true; fail "$suite tests"; }
    echo "$out" | grep -q -E '^# fail 0$' || fail "$suite: could not confirm 0 failures"
    echo "ok: $suite $(echo "$out" | grep -E '^# pass ' | head -1)"
  done

  step "5. generated pages are up to date"
  local before after
  before="$(find site/status site/errors site/alerts -type f -print0 | sort -z | xargs -0 sha256sum)"
  node tools/status-pages.mjs >/dev/null || fail "tools/status-pages.mjs crashed"
  after="$(find site/status site/errors site/alerts -type f -print0 | sort -z | xargs -0 sha256sum)"
  if [ "$before" != "$after" ]; then
    diff <(echo "$before") <(echo "$after") >&2 || true
    fail "status-pages.mjs changed generated pages: run it, then re-run preflight"
  fi
  echo "ok: status, errors and alerts pages unchanged"
}

checks

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo; echo "PASS (checks 1-5). Add a version, e.g. bash tools/preflight.sh 1.18.3, to build the zip."
  exit 0
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version must look like 1.18.3"

step "6. build zip and re-check from a clean copy"
command -v zip >/dev/null || fail "zip is not installed"
command -v unzip >/dev/null || fail "unzip is not installed"
ROOT="$(pwd)"
ZIP="$(cd "$ROOT/.." && pwd)/outageradar-v${VERSION//./_}.zip"
rm -f "$ZIP"
list_files | zip -q -X "$ZIP" -@ || fail "zip"
if unzip -Z1 "$ZIP" | grep -E '(^|/)(__pycache__|node_modules)(/|$)|\.pyc$'; then
  fail "zip contains caches or node_modules"
fi
echo "zip: $ZIP ($(unzip -Z1 "$ZIP" | wc -l | tr -d ' ') files)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP/copy"
(
  cd "$TMP/copy"
  git init -q
  git add -A
  checks
) || fail "checks failed in the unzipped copy"

echo; echo "PASS: all checks here and in the unzipped copy. Release zip: $ZIP"
