#!/usr/bin/env python3
"""
Extracts data tables from a PostgreSQL custom dump (PGDMP) into JSON.
Used by migrate-cfmono-dump.js to import data into the app schema.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import pgdumplib


TABLE_COLUMNS: dict[str, list[str]] = {
    "User": [
        "id",
        "email",
        "firstName",
        "lastName",
        "displayName",
        "position",
        "preferredFoot",
        "chemistryStyle",
        "shirtNumber",
        "attributes",
        "age",
        "ipAddress",
        "gender",
        "pictureKey",
        "createdAt",
        "updatedAt",
        "password",
        "matchGuestForId",
    ],
    "League": [
        "id",
        "name",
        "active",
        "inviteCode",
        "maxGames",
        "createdAt",
        "updatedAt",
        "showPoints",
    ],
    "Match": [
        "id",
        "start",
        "end",
        "location",
        "homeTeamName",
        "awayTeamName",
        "createdAt",
        "updatedAt",
        "awayTeamGoals",
        "homeTeamGoals",
        "leagueId",
        "notes",
    ],
    "MatchStatistic": [
        "id",
        "matchId",
        "userId",
        "value",
        "type",
        "createdAt",
    ],
    "Vote": [
        "id",
        "matchId",
        "createdAt",
        "byUserId",
        "forUserId",
    ],
    "Session": [
        "id",
        "ipAddress",
        "ipLocation",
        "createdAt",
        "updatedAt",
        "userId",
    ],
    "_users": ["A", "B"],
    "_admins": ["A", "B"],
    "_homeTeamUsers": ["A", "B"],
    "_awayTeamUsers": ["A", "B"],
    "_availableUsers": ["A", "B"],
}


def _rows_to_dicts(dump: pgdumplib.dump.Dump, table_name: str, columns: list[str]) -> list[dict]:
    rows: list[dict] = []
    for raw in dump.table_data("public", table_name):
        if not isinstance(raw, tuple):
            continue
        record: dict[str, object] = {}
        for idx, col_name in enumerate(columns):
            record[col_name] = raw[idx] if idx < len(raw) else None
        rows.append(record)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract rows from PGDMP to JSON.")
    parser.add_argument("--file", required=True, help="Path to PGDMP dump file")
    parser.add_argument("--out", help="Optional output JSON file path")
    args = parser.parse_args()

    input_path = pathlib.Path(args.file).expanduser()
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 1

    dump = pgdumplib.load(str(input_path))
    payload = {"sourceFile": str(input_path), "tables": {}, "counts": {}}

    for table_name, columns in TABLE_COLUMNS.items():
        rows = _rows_to_dicts(dump, table_name, columns)
        payload["tables"][table_name] = rows
        payload["counts"][table_name] = len(rows)

    output = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    if args.out:
        output_path = pathlib.Path(args.out).expanduser()
        output_path.write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
