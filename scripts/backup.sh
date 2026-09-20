#!/usr/bin/env bash
#
# Exports the database to a dated SQL file.
#
# Time Travel on the free plan keeps seven days (spec 2.5). Corruption
# noticed in week two is gone, and these are a child's records, so they do
# not get to live only inside one free tier's database.
#
# Usage:
#   scripts/backup.sh                      the deployed database
#   scripts/backup.sh --local              the local dongfan-dev, for drills
#   scripts/backup.sh --output <file>      somewhere other than the default
#
# Exit status is what the scheduled job reads: anything but zero means there
# is no usable backup for this run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$REPO_ROOT/packages/api"

PRODUCTION_DATABASE="dongfan"
DEV_DATABASE="dongfan-dev"

REMOTE=1
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)  REMOTE=0; shift ;;
    --remote) REMOTE=1; shift ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [[ $REMOTE -eq 1 ]]; then
  DATABASE="$PRODUCTION_DATABASE"
  # Always spelled out. `wrangler d1 export` accepts both --local and
  # --remote, and its default when neither is given is not documented.
  # Guessing wrong writes an empty local database to the file and says
  # nothing at all; you find out on the day you need to restore (spec 12.2).
  SCOPE="--remote"
  LABEL="REMOTE $DATABASE (deployed)"
else
  DATABASE="$DEV_DATABASE"
  SCOPE="--local"
  LABEL="local $DATABASE"
fi

: "${OUTPUT:=$REPO_ROOT/backup-$(date +%Y-%m-%d).sql}"

echo "Exporting $LABEL"
echo "        -> $OUTPUT"

# Named by config file rather than by changing directory, so the command
# reads the same wherever it is run from -- including a scheduled job.
npx wrangler d1 export "$DATABASE" "$SCOPE" \
  --config "$API_DIR/wrangler.jsonc" \
  --output "$OUTPUT" \
  || { echo "Export failed." >&2; exit 1; }

# ---------------------------------------------------------------- sanity

# A file is not a backup. An export that ran against the wrong database, or
# against an empty one, produces a perfectly valid file with a schema in it
# and no records, and without this check nothing would ever say so.
fail() {
  echo "Backup rejected: $1" >&2
  echo "Keeping $OUTPUT for inspection." >&2
  exit 1
}

[[ -s "$OUTPUT" ]] || fail "the file is empty"
grep -q 'CREATE TABLE.*events' "$OUTPUT" || fail "no events table in the export"
grep -q 'INSERT INTO.*events' "$OUTPUT" || fail "no event rows in the export"

EVENT_ROWS=$(grep -c 'INSERT INTO.*events' "$OUTPUT" || true)
BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')

echo "OK: $EVENT_ROWS event insert statements, $BYTES bytes."
echo
echo "This proves the file has records in it. It does not prove they can be"
echo "restored -- only a drill does that: npm run restore:drill -- $OUTPUT"
