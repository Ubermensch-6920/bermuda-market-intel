#!/usr/bin/env python3
"""Seed data/commodities_history.jsonl from past commits of data/commodities.json.

Yahoo stops serving a futures contract once it expires, so the pipeline keeps
its own daily snapshot of the curve to answer 1M/3M/1Y "what was this tenor
worth then" lookups. This rebuilds that history from the data commits the
workflow has been making (the latest snapshot of each day wins). Rows already
in the history file are kept as-is.

Needs full git history: `git fetch --unshallow` first on a shallow clone.
Run: python scripts/backfill_commodity_history.py
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_all import (COMM_HISTORY_FILE, commodity_history_row,  # noqa: E402
                       load_commodity_history, log)

REPO = Path(__file__).parent.parent
PATH = "data/commodities.json"


def git(*args):
    return subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True).stdout


def main():
    commits = git("log", "--format=%H %cI", "--", PATH).split("\n")
    by_date = {}
    for line in commits:
        if not line.strip():
            continue
        sha, committed = line.split()
        try:
            payload = json.loads(git("show", f"{sha}:{PATH}"))
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            continue
        row_date = payload.get("date") or committed[:10]
        if row_date in by_date:  # log is newest-first: keep the day's last snapshot
            continue
        row = commodity_history_row(payload, row_date, live=False)
        if len(row) > 1:
            by_date[row_date] = row

    existing = {r["date"]: r for r in load_commodity_history()}
    added = [d for d in by_date if d not in existing]
    merged = {**by_date, **existing}
    rows = [merged[d] for d in sorted(merged)]
    COMM_HISTORY_FILE.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
    log.info(f"commodity history: {len(rows)} days ({len(added)} backfilled from {len(commits)} commits)"
             + (f", {rows[0]['date']} .. {rows[-1]['date']}" if rows else ""))


if __name__ == "__main__":
    main()
