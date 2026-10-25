import sqlite3
from datetime import datetime
from pathlib import Path

from conftest import stamp
from bug_validator_tui.checks import Related, Result, load_checks
from bug_validator_tui.fmt import comment_text, result_label


def test_reads_every_row_latest_check_first(state: Path) -> None:
    checks = load_checks(state / "bug-validator.sqlite")

    assert [c.key for c in checks] == ["KAZ-2", "RPG-4", "KAZ-3", "KAZ-5", "KAZ-1"]
    assert [c.result for c in checks] == [Result.COMMENT, Result.ERROR, Result.NO_COMMENT, Result.COMMENT, Result.SKIPPED]
    commented = checks[0]
    assert (commented.summary, commented.reporter) == ("Ports table is empty after clearing the filter", "A Tester")
    assert commented.missing == ("R4", "R6")
    assert commented.related == (Related("KAZ-1", "the same empty table"),)
    assert [b.id for b in commented.base_checks if not b.passed] == ["R4", "R6"]
    assert checks[1].error == "Error: agent run timed out" and checks[1].base_checks == ()


def test_reads_a_database_made_before_summary_and_reporter_and_rows_without_a_time(tmp_path: Path) -> None:
    db = tmp_path / "old.sqlite"
    connection = sqlite3.connect(db)
    connection.execute("CREATE TABLE checks (key TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checked_at TEXT, base_checks TEXT, verdict TEXT, comment TEXT, comment_id TEXT, error TEXT)")
    connection.execute("INSERT INTO checks (key, status, checked_at) VALUES ('KAZ-1', 'skipped', ?)", (stamp(datetime.now()),))
    connection.execute("INSERT INTO checks (key, status) VALUES ('KAZ-0', 'skipped')")
    connection.commit()
    connection.close()

    first, last = load_checks(db)
    assert (first.key, first.summary, first.reporter) == ("KAZ-1", None, None)
    assert last.key == "KAZ-0"


def test_a_file_that_is_not_a_database_is_no_checks(tmp_path: Path) -> None:
    (tmp_path / "junk.sqlite").write_text("not a database")
    assert load_checks(tmp_path / "junk.sqlite") == []


def test_no_database_yet_is_no_checks(tmp_path: Path) -> None:
    assert load_checks(tmp_path / "missing.sqlite") == []
    (tmp_path / "empty.sqlite").touch()
    assert load_checks(tmp_path / "empty.sqlite") == []


def test_the_comment_names_the_reporter_and_each_result_has_a_label(state: Path) -> None:
    checks = {c.key: c for c in load_checks(state / "bug-validator.sqlite")}

    assert comment_text(checks["KAZ-2"].comment, "A Tester").splitlines()[0] == "@A Tester"
    assert comment_text(checks["KAZ-5"].comment, None).splitlines()[0] == "@reporter"
    assert [result_label(checks[k]) for k in ("KAZ-1", "KAZ-2", "KAZ-3", "RPG-4")] == [
        "skipped", "comment · dry run", "no comment", "check failed"
    ]
