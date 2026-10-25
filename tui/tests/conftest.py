import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
MENTION = "[~accountid:712020:abc]"


def stamp(at: datetime) -> str:
    """A local time as the service writes it: ISO, UTC, "Z"."""
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def base_checks(failed: set[str]) -> str:
    return json.dumps([{"id": f"R{n}", "passed": f"R{n}" not in failed, "detail": f"detail of R{n}"} for n in range(1, 7)])


def insert(db: Path, **row) -> None:
    connection = sqlite3.connect(db)
    connection.execute(f"INSERT INTO checks ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})", tuple(row.values()))
    connection.commit()
    connection.close()


def log_line(event: str, at: datetime, **fields) -> str:
    return json.dumps({"ts": stamp(at), "level": "info", "event": event, **fields}) + "\n"


@pytest.fixture
def state(tmp_path: Path) -> Path:
    """A state directory: one bug skipped at the first start, two commented on, one complete, one
    whose check failed; and a log of a dry run polling a minute ago."""
    now = datetime.now()
    db = tmp_path / "bug-validator.sqlite"
    connection = sqlite3.connect(db)
    connection.executescript(SCHEMA)
    connection.close()

    insert(db, key="KAZ-1", status="skipped", checked_at=stamp(now - timedelta(days=20)))
    insert(
        db,
        key="KAZ-2",
        status="dry_run",
        attempts=1,
        checked_at=stamp(now),
        summary="Ports table is empty after clearing the filter",
        reporter="A Tester",
        base_checks=base_checks({"R4", "R6"}),
        verdict=json.dumps(
            {
                "comment_needed": True,
                "comment": "…",
                "missing": ["R4", "R6"],
                "related": [{"key": "KAZ-1", "reason": "the same empty table"}],
            }
        ),
        comment=f"{MENTION}\nPlease add:\n- Build\n- HAR file",
    )
    insert(
        db,
        key="KAZ-3",
        status="complete",
        attempts=1,
        checked_at=stamp(now - timedelta(days=3)),
        summary="Login page freezes",
        reporter="B Tester",
        base_checks=base_checks(set()),
        verdict=json.dumps({"comment_needed": False, "comment": "", "missing": [], "related": []}),
    )
    insert(db, key="RPG-4", status="failed", attempts=3, checked_at=stamp(now - timedelta(days=1)), error="Error: agent run timed out")
    insert(
        db,
        key="KAZ-5",
        status="dry_run",
        attempts=1,
        checked_at=stamp(now - timedelta(days=10)),
        summary="Device list is cut",
        base_checks=base_checks({"R6"}),
        verdict=json.dumps({"comment_needed": True, "comment": "…", "missing": ["R6"], "related": []}),
        comment=f"{MENTION}\nPlease attach a HAR file.",
    )

    (tmp_path / "service.log").write_text(
        log_line("service_start", now - timedelta(hours=2), dryRun=True, pollIntervalS=180, model="haiku")
        + log_line("poll", now - timedelta(minutes=1), inQuery=7, pending=0, checked=0, failed=0)
    )
    return tmp_path
