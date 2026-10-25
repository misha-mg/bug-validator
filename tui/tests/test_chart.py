from collections import Counter
from datetime import date

from bug_validator_tui.chart import day_bars
from bug_validator_tui.checks import Result


def test_bars_scale_to_the_busiest_day_stack_results_and_carry_their_counts() -> None:
    days = [
        (date(2026, 10, 1), Counter({Result.NO_COMMENT: 1, Result.COMMENT: 2, Result.ERROR: 1})),
        (date(2026, 10, 2), Counter()),
        (date(2026, 10, 3), Counter({Result.COMMENT: 1})),
    ]
    chart = day_bars(days, height=4)

    assert [line.rstrip() for line in chart.plain.splitlines()] == [
        " 4",
        "██",
        "██",
        "██     1",
        "██    ██",
        "01 02 03",
        "■ without comment  ■ with comment  ■ error",
    ]
    # The error is the top cell of its bar.
    top_cell = min(chart.spans, key=lambda span: span.start)
    assert top_cell.style == "$error"
