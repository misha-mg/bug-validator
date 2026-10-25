"""How times, shares and results are written on screen."""

from __future__ import annotations

import re
from datetime import timedelta

from .checks import MAX_ATTEMPTS, Check, Result
from .stats import Share

# Theme variables a result is drawn in; Rich tables take the values, Content the names. A skipped
# bug is drawn dim.
RESULT_COLORS = {
    Result.COMMENT: "accent",
    Result.NO_COMMENT: "success",
    Result.ERROR: "error",
}

MENTION = re.compile(r"\[~accountid:[^\]]*\]")


def span(span_: timedelta) -> str:
    minutes = int(span_.total_seconds()) // 60
    return f"{minutes // 60}h {minutes % 60:02d}m" if minutes >= 60 else f"{minutes}m"


def ago(span_: timedelta) -> str:
    """"just now", "5m ago", "2h 05m ago", "3d 04h ago"."""
    if span_ < timedelta(minutes=1):
        return "just now"
    if span_ < timedelta(days=1):
        return f"{span(span_)} ago"
    return f"{span_.days}d {span_.seconds // 3600:02d}h ago"


def bugs(n: int) -> str:
    return f"{n} bug" if n == 1 else f"{n} bugs"


def share(share_: Share) -> str:
    """"85% (11)": the percentage, and how many it is."""
    return f"{share_.ratio:.0%} ({share_.count})" if share_.ratio is not None else "–"


def result_label(check: Check) -> str:
    if check.status == "dry_run":
        return "comment · dry run"
    if check.status == "commented":
        return "commented"
    if check.status == "retry":
        return f"retrying · {check.attempts} of {MAX_ATTEMPTS} failed"
    if check.status == "failed":
        return "check failed"
    if check.status == "posting":
        return "interrupted while posting"
    return {Result.NO_COMMENT: "no comment", Result.SKIPPED: "skipped"}.get(check.result, check.status)


def comment_text(comment: str, reporter: str | None) -> str:
    """The comment as Jira shows it: the mention by name rather than by account id."""
    return MENTION.sub(f"@{reporter}" if reporter else "@reporter", comment)


def cut(text: str, width: int) -> str:
    """One line of at most width characters."""
    line = " ".join(text.split())
    return line if len(line) <= width else line[: width - 1] + "…"
