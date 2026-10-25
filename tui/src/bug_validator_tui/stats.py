"""What the checks add up to: counts by period, the most common gaps, checks per day, and the
checks that failed."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .checks import REQUIREMENTS, Check, Result


@dataclass(frozen=True)
class Share:
    """count of total; with a handful of bugs a percentage alone says little, so both are kept."""

    count: int
    total: int

    @property
    def ratio(self) -> float | None:
        return self.count / self.total if self.total else None


@dataclass(frozen=True)
class Stats:
    # Bugs checked to the end, by the time of the check.
    checked: int
    without_comment: Share
    with_comment: Share
    # Bugs whose last attempt failed: to be tried again, or left after the last attempt.
    errors: int


def period_stats(checks: list[Check], since: datetime | None = None) -> Stats:
    """Stats of the checks made at or after since (all of them when since is None)."""
    inside = [c for c in checks if since is None or c.checked_at >= since]
    done = [c for c in inside if c.checked]
    commented = [c for c in done if c.result is Result.COMMENT]
    return Stats(
        checked=len(done),
        without_comment=Share(len(done) - len(commented), len(done)),
        with_comment=Share(len(commented), len(done)),
        errors=sum(c.result is Result.ERROR for c in inside),
    )


@dataclass(frozen=True)
class Problem:
    id: str
    name: str
    # Bugs whose first check found this requirement failed, of every bug checked to the end.
    share: Share


def problems(checks: list[Check]) -> list[Problem]:
    """Every requirement with how often the first checks found it failed, the most common first:
    the reports as they arrived, which is what the PRD's success metric is about."""
    done = [c for c in checks if c.checked]
    failed = Counter(requirement for c in done for requirement in c.first_missing)
    found = [Problem(id, name, Share(failed[id], len(done))) for id, name in REQUIREMENTS.items()]
    # sorted() keeps R1–R8 order among equal counts.
    return sorted(found, key=lambda p: -p.share.count)


def checks_per_day(checks: list[Check], last_day: date, days: int) -> list[tuple[date, Counter[Result]]]:
    """Checks by the day they were made and their result, oldest day first; skipped bugs left out."""
    first_day = last_day - timedelta(days=days - 1)
    per_day: dict[date, Counter[Result]] = {first_day + timedelta(days=i): Counter() for i in range(days)}
    for check in checks:
        if check.result is not Result.SKIPPED and check.checked_at.date() in per_day:
            per_day[check.checked_at.date()][check.result] += 1
    return list(per_day.items())


def needs_attention(checks: list[Check]) -> list[Check]:
    """Checks whose last attempt failed, the latest first."""
    return [c for c in checks if c.result is Result.ERROR]
