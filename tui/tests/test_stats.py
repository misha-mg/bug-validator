from datetime import datetime, time, timedelta
from pathlib import Path

from bug_validator_tui.checks import Result, load_checks
from bug_validator_tui.stats import Share, checks_per_day, needs_attention, period_stats, problems


def test_counts_the_checks_of_each_period(state: Path) -> None:
    checks = load_checks(state / "bug-validator.sqlite")
    now = datetime.now()

    today = period_stats(checks, datetime.combine(now.date(), time()))
    assert (today.checked, today.with_comment, today.errors) == (1, Share(1, 1), 0)

    week = period_stats(checks, now - timedelta(days=7))
    assert (week.checked, week.without_comment, week.with_comment, week.errors) == (2, Share(1, 2), Share(1, 2), 1)

    # The skipped bug is not a checked one.
    every = period_stats(checks)
    assert (every.checked, every.without_comment, every.with_comment) == (3, Share(1, 3), Share(2, 3))


def test_problems_are_the_requirements_found_failed_most_common_first(state: Path) -> None:
    found = problems(load_checks(state / "bug-validator.sqlite"))

    assert [(p.id, p.share) for p in found[:3]] == [("R6", Share(2, 3)), ("R4", Share(1, 3)), ("R1", Share(0, 3))]
    assert [p.id for p in found] == ["R6", "R4", "R1", "R2", "R3", "R5", "R7"]


def test_checks_per_day_leave_out_skipped_bugs(state: Path) -> None:
    checks = load_checks(state / "bug-validator.sqlite")
    today = datetime.now().date()

    days = checks_per_day(checks, today, 30)
    assert len(days) == 30 and days[-1][0] == today
    counts = dict(days)
    assert counts[today] == {Result.COMMENT: 1}
    assert counts[today - timedelta(days=1)] == {Result.ERROR: 1}
    assert sum(sum(c.values()) for c in counts.values()) == 4


def test_needs_attention_is_the_failed_checks(state: Path) -> None:
    assert [c.key for c in needs_attention(load_checks(state / "bug-validator.sqlite"))] == ["RPG-4"]
