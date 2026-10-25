"""Bugs checked per day as stacked bars, drawn with block characters in the theme's colors."""

from __future__ import annotations

from collections import Counter
from datetime import date
from math import ceil

from textual.content import Content
from textual.widget import Widget

from .checks import Check, Result
from .stats import checks_per_day

# Bottom to top: a day's errors sit on top of its bar, where they catch the eye.
STACK = (
    (Result.NO_COMMENT, "$success"),
    (Result.COMMENT, "$accent"),
    (Result.ERROR, "$error"),
)
BAR = "██"
# A bar and the gap after it.
DAY_WIDTH = len(BAR) + 1


class DayChart(Widget):
    """Bugs checked per day: as many days as the width holds, up to max_days, the latest on the right."""

    def __init__(self, max_days: int, height: int, **kwargs) -> None:
        super().__init__(**kwargs)
        self._max_days = max_days
        self._height = height
        self._checks: list[Check] = []
        # The bars, the count above them, the day numbers and the legend.
        self.styles.height = height + 3

    def show(self, checks: list[Check]) -> None:
        self._checks = checks
        self.refresh()

    def render(self) -> Content:
        days = max(1, min(self._max_days, (self.size.width + 1) // DAY_WIDTH))
        return day_bars(checks_per_day(self._checks, date.today(), days), self._height)


def day_bars(days: list[tuple[date, Counter[Result]]], height: int) -> Content:
    """One bar per day, scaled so the busiest day is height rows, its count just above it; day
    numbers below, legend last."""
    top = max((sum(counts.values()) for _, counts in days), default=0)
    columns = [_column(counts, top, height) for _, counts in days]
    totals = [sum(counts.values()) for _, counts in days]
    lines = []
    # One row more than the bars: the busiest day's count sits above its full-height bar.
    for row in reversed(range(height + 1)):
        parts: list[tuple[str, str] | str] = []
        for column, total in zip(columns, totals):
            if parts:
                parts.append(" ")
            filled = height - column.count(None)
            if row < filled:
                parts.append((BAR, column[row]))
            elif row == filled and total:
                parts.append(str(total).rjust(len(BAR)))
            else:
                parts.append(" " * len(BAR))
        lines.append(Content.assemble(*parts))
    lines.append(Content(" ".join(f"{day:%d}" for day, _ in days)))
    lines.append(_legend())
    return Content("\n").join(lines)


def _column(counts: Counter[Result], top: int, height: int) -> list[str | None]:
    """A bar's cells, bottom up: each holds its result's style, or None above the bar."""
    cells: list[str | None] = []
    total = 0
    for kind, style in STACK:
        # Rounding the running total up keeps a single bug visible on the busiest day's scale.
        before, total = total, total + counts[kind]
        cells += [style] * (ceil(total * height / top) - ceil(before * height / top)) if top else []
    return cells + [None] * (height - len(cells))


def _legend() -> Content:
    parts: list[tuple[str, str] | str] = []
    for kind, style in STACK:
        parts += [("■ ", style), kind.value, "  "]
    return Content.assemble(*parts[:-1])
