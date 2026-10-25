"""The first screen: the service, the statistics, the most common gaps, and the checks that failed."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, time, timedelta
from pathlib import Path

from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.color import Color
from textual.containers import Horizontal, Vertical
from textual.content import Content
from textual.widgets import DataTable, Footer, Header, Static

from .banner import banner
from .bug_view import BugScreen
from .bugs import BugsScreen
from .chart import DayChart
from .checks import MAX_ATTEMPTS, Check, Result, load_checks
from .fmt import ago, bugs, cut, share, span
from .live import LiveScreen
from .service import Liveness, ServiceLog, ServiceStatus, liveness
from .stats import Problem, Stats, needs_attention, period_stats, problems

WEEK = timedelta(days=7)
# The chart's longest period; a narrower terminal shows fewer days.
CHART_DAYS = 30
CHART_HEIGHT = 5
BAR_WIDTH = 12
ERROR_WIDTH = 72


class HomeScreen(LiveScreen):
    BINDINGS = [("b", "bugs", "All bugs")]
    DEFAULT_CSS = """
    HomeScreen #banner { width: 100%; padding: 1 2 0 2; content-align: center top; text-wrap: nowrap; text-overflow: clip; }
    HomeScreen .block { border: round $primary; padding: 1 2; height: auto; }
    /* The statistics block's height: table 6 + gap 1 + chart 8, padding 2, border 2. */
    HomeScreen #top { height: 19; }
    HomeScreen #top > .block { width: 1fr; height: 100%; }
    /* A month of bars, three columns a day. */
    HomeScreen #top > #statistics { width: 2fr; }
    HomeScreen #chart { margin-top: 1; }
    HomeScreen #bottom { height: 1fr; }
    HomeScreen #bottom > .block { width: 1fr; height: 100%; }
    /* Under the blocks above, so their edges line up. */
    HomeScreen #bottom > #attention-block { width: 2fr; }
    HomeScreen #attention { height: 1fr; }
    """

    def __init__(self, db: Path, service_log: ServiceLog) -> None:
        super().__init__()
        self._db = db
        self._service_log = service_log
        self._attention: dict[str, Check] = {}

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="banner")
        with Horizontal(id="top"):
            yield Static(id="service", classes="block")
            with Vertical(id="statistics", classes="block"):
                yield Static(id="stats")
                yield DayChart(CHART_DAYS, CHART_HEIGHT, id="chart")
        with Horizontal(id="bottom"):
            yield Static(id="problems", classes="block")
            with Vertical(id="attention-block", classes="block"):
                yield DataTable(id="attention", cursor_type="row")
                yield Static("No check has failed.", id="all-clear")
        yield Footer()

    def on_mount(self) -> None:
        theme = self.app.current_theme
        background, foreground = Color.parse(theme.background), Color.parse(theme.foreground)
        self.query_one("#banner", Static).update(
            banner(Color.parse(theme.primary), Color.parse(theme.accent), background.blend(foreground, 0.45))
        )
        self.query_one("#service").border_title = "Service"
        self.query_one("#statistics").border_title = "Statistics"
        self.query_one("#statistics").border_subtitle = "bugs checked per day"
        self.query_one("#problems").border_title = "Most common gaps"
        self.query_one("#attention-block").border_title = "Needs attention · failed checks"
        self.query_one("#attention", DataTable).add_columns("Bug", "Last try", "Attempts", "Error")

    def action_refresh(self) -> None:
        checks = load_checks(self._db)
        now = datetime.now()
        colors = self.app.theme_variables
        status = self._service_log.read()
        self.query_one("#service", Static).update(_service_text(status, checks, now, self._service_log.path))
        self.query_one("#stats", Static).update(_stats_table(checks, now, colors))
        self.query_one(DayChart).show(checks)
        found = problems(checks)
        block = self.query_one("#problems", Static)
        checked = found[0].share.total
        block.border_subtitle = f"of {bugs(checked)} checked · all time" if checked else ""
        block.update(_problems_table(found, colors) if checked else "No bug has been checked yet.")
        self._show_attention(needs_attention(checks))

    def action_bugs(self) -> None:
        self.app.push_screen(BugsScreen(self._db))

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        self.app.push_screen(BugScreen(self._attention[event.row_key.value]))

    def _show_attention(self, checks: list[Check]) -> None:
        table = self.query_one("#attention", DataTable)
        self._attention = {check.key: check for check in checks}
        table.clear()
        for key, check in self._attention.items():
            attempts = f"{check.attempts} of {MAX_ATTEMPTS}" + (", gave up" if check.status == "failed" else "")
            table.add_row(key, f"{check.checked_at:%d %b %H:%M}", attempts, cut(check.error or "", ERROR_WIDTH), key=key)
        table.display = bool(checks)
        self.query_one("#all-clear").display = not checks


def _service_text(status: ServiceStatus | None, checks: list[Check], now: datetime, log: Path) -> Content:
    """One short value per row; the labels carry the meaning, so the values stay to a word or two."""
    rows: list[tuple[str, Content | str]] = []
    if status is None:
        rows.append(("State", Content.styled(f"no log at {log}", "$text-muted")))
    else:
        rows += _status_rows(status, now)
    skipped = [c for c in checks if c.result is Result.SKIPPED]
    if skipped:
        # Bugs already in Created at the first start, never checked.
        first = min(c.checked_at for c in skipped)
        rows.append(("Skipped", f"{len(skipped)} · {first:%d %b}"))
    if not checks:
        rows.append(("Database", Content.styled("none yet", "$text-muted")))
    return Content("\n").join(Content.assemble((f"{label:<10}", "bold"), "   ", value) for label, value in rows)


def _status_rows(status: ServiceStatus, now: datetime) -> list[tuple[str, Content | str]]:
    state = liveness(status, now)
    rows: list[tuple[str, Content | str]] = []
    if state is Liveness.RUNNING:
        rows.append(("State", Content.styled("running", "$success")))
    elif state is Liveness.STOPPED:
        when = f" · {ago(now - status.last_seen)}" if status.last_seen else ""
        rows.append(("State", Content.styled(f"stopped{when}", "$warning")))
    else:
        quiet = f" · {span(now - status.last_seen)}" if status.last_seen else ""
        rows.append(("State", Content.styled(f"silent{quiet}", "$error")))

    if status.poll_error:
        rows.append(("Last poll", Content.styled(f"failed · {ago(now - status.last_poll)}", "$error")))
        rows.append(("Error", Content.styled(status.poll_error, "$error")))
    elif status.last_poll:
        rows.append(("Last poll", ago(now - status.last_poll)))
    else:
        rows.append(("Last poll", Content.styled("none yet", "$text-muted")))

    if status.dry_run is True:
        rows.append(("Mode", Content.styled("dry run", "bold $secondary")))
    elif status.dry_run is False:
        rows.append(("Mode", Content.styled("live", "bold $accent")))
    if status.in_query is not None and not status.poll_error:
        waiting = f" · {status.waiting} waiting" if status.waiting else ""
        rows.append(("In Created", f"{status.in_query}{waiting}"))
    if status.started:
        rows.append(("Started", f"{status.started:%d %b %H:%M}"))
    if status.model:
        rows.append(("Model", status.model))
    return rows


def _stats_table(checks: list[Check], now: datetime, colors: dict[str, str]) -> Table:
    columns = [
        ("Today", period_stats(checks, datetime.combine(now.date(), time()))),
        ("7 days", period_stats(checks, now - WEEK)),
        ("All time", period_stats(checks)),
    ]
    table = Table.grid(padding=(0, 3))
    table.add_column(no_wrap=True)
    for _ in columns:
        table.add_column(justify="right", no_wrap=True)
    table.add_row("", *(Text(title, style="bold") for title, _ in columns))

    def errors(s: Stats) -> Text:
        return Text(str(s.errors), style=colors["error"] if s.errors else "")

    rows: list[tuple[str, Callable[[Stats], str | Text]]] = [
        ("Checked", lambda s: str(s.checked)),
        ("Without comment", lambda s: share(s.without_comment)),
        ("With comment", lambda s: share(s.with_comment)),
        ("Check failed", errors),
    ]
    for label, cell in rows:
        table.add_row(label, *(cell(stats) for _, stats in columns))
    return table


def _problems_table(found: list[Problem], colors: dict[str, str]) -> Table:
    top = max(p.share.count for p in found)
    table = Table.grid(padding=(0, 2))
    table.add_column(no_wrap=True)
    # The one column a narrow block takes width from; the name is cut rather than wrapped.
    table.add_column()
    table.add_column(no_wrap=True, width=BAR_WIDTH)
    table.add_column(justify="right", no_wrap=True)
    for problem in found:
        count = problem.share.count
        # A gap found once still gets a cell.
        bar = Text("█" * max(round(count * BAR_WIDTH / top), 1) if count else "", style=colors["accent"])
        dim = "" if count else "dim"
        name = Text(problem.name, style=dim, no_wrap=True, overflow="ellipsis")
        table.add_row(Text(problem.id, style=f"bold {dim}"), name, bar, Text(share(problem.share), style=dim))
    return table
