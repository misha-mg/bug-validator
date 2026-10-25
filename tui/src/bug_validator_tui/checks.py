"""The service's database, read-only: one row per bug it has dealt with (docs/architecture.md)."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path

# The requirements of src/domain/bug.ts, R7 shortened to fit a block. Related bugs are not a
# requirement: they are what the service adds.
REQUIREMENTS = {
    "R1": "Steps to reproduce",
    "R2": "Expected result",
    "R3": "Actual result",
    "R4": "Affects versions",
    "R5": "Device",
    "R6": "HAR file",
    "R7": "Right project",
}
# config.ts: a bug's check is tried this many times, then left as failed.
MAX_ATTEMPTS = 3


class Result(Enum):
    COMMENT = "with comment"
    NO_COMMENT = "without comment"
    ERROR = "error"
    SKIPPED = "skipped"


# The row statuses of src/db/store.ts. A dry-run comment counts as a comment: it was written,
# only not posted. A `posting` row was interrupted between the post and its record: whether the
# comment reached Jira is for a human to check, so it needs attention.
RESULTS = {
    "commented": Result.COMMENT,
    "dry_run": Result.COMMENT,
    "complete": Result.NO_COMMENT,
    "posting": Result.ERROR,
    "retry": Result.ERROR,
    "failed": Result.ERROR,
    "skipped": Result.SKIPPED,
}


@dataclass(frozen=True)
class BaseCheck:
    id: str
    passed: bool
    detail: str


@dataclass(frozen=True)
class Related:
    key: str
    reason: str


@dataclass(frozen=True)
class Check:
    key: str
    status: str
    attempts: int
    # The last attempt, in local time.
    checked_at: datetime
    # Rows written before the service kept them have neither, and a skipped bug was never read.
    summary: str | None
    reporter: str | None
    base_checks: tuple[BaseCheck, ...]
    # The agent's list of failed requirements, R1–R7.
    missing: tuple[str, ...]
    related: tuple[Related, ...]
    comment: str | None
    error: str | None

    @property
    def result(self) -> Result:
        return RESULTS.get(self.status, Result.ERROR)

    @property
    def checked(self) -> bool:
        """Checked to the end, with a comment or without one."""
        return self.result in (Result.COMMENT, Result.NO_COMMENT)


def load_checks(db: Path) -> list[Check]:
    """Every row, the latest check first; none before the service has made its database."""
    if not db.is_file():
        return []
    # Read-only, so the TUI can never change what the service decides on; it waits out a write.
    connection = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute("SELECT * FROM checks").fetchall()
    except sqlite3.Error:
        # The file is there, the table not yet (the service is creating it), or it is not a database.
        return []
    finally:
        connection.close()
    return sorted((_check(row) for row in rows), key=lambda c: c.checked_at, reverse=True)


def local_time(stamp: str | None) -> datetime:
    """A time the service wrote (ISO, UTC, "Z") in local time without a zone, as datetime.now() gives.
    A row without one (a hand-made row) sorts last."""
    if not stamp:
        return datetime.min
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)


def _check(row: sqlite3.Row) -> Check:
    columns = row.keys()
    verdict = _json(row["verdict"]) or {}
    return Check(
        key=row["key"],
        status=row["status"],
        attempts=row["attempts"],
        checked_at=local_time(row["checked_at"]),
        summary=row["summary"] if "summary" in columns else None,
        reporter=row["reporter"] if "reporter" in columns else None,
        base_checks=tuple(BaseCheck(c["id"], c["passed"], c["detail"]) for c in _json(row["base_checks"]) or []),
        missing=tuple(verdict.get("missing", [])),
        related=tuple(Related(r["key"], r["reason"]) for r in verdict.get("related", [])),
        comment=row["comment"],
        error=row["error"],
    )


def _json(text: str | None):
    return json.loads(text) if text else None
