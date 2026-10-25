"""Every bug the service has dealt with, grouped by the day of its check, with a filter by result
and a search."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from rich.text import Text
from textual.app import ComposeResult
from textual.widgets import DataTable, Footer, Header, Input

from .bug_view import BugScreen
from .checks import Check, Result, load_checks
from .fmt import RESULT_COLORS, cut, result_label
from .live import LiveScreen

# Longer summaries are cut; the bug's own screen has the whole of it.
SUMMARY_WIDTH = 60


def _has(kind: Result) -> Callable[[Check], bool]:
    return lambda check: check.result is kind


# What `f` steps through, in order; the first shows every bug.
FILTERS: tuple[tuple[str, Callable[[Check], bool]], ...] = (
    ("all", lambda check: True),
    *((kind.value, _has(kind)) for kind in Result),
)


class BugsScreen(LiveScreen):
    BINDINGS = [("escape", "back", "Back"), ("f", "next_filter", "Filter"), ("slash", "search", "Search")]
    DEFAULT_CSS = """
    BugsScreen #search { dock: bottom; display: none; }
    """

    def __init__(self, db: Path) -> None:
        super().__init__()
        self._db = db
        self._checks: dict[str, Check] = {}
        self._filter = 0
        # The row the cursor was last on, to tell which way it moves when it lands on a day row.
        self._last_row = 0

    def compose(self) -> ComposeResult:
        yield Header()
        yield DataTable(cursor_type="row", zebra_stripes=True)
        yield Input(placeholder="Search a bug, its summary or reporter · Enter keeps it · Esc clears it", id="search")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one(DataTable)
        table.add_columns("Bug")
        table.add_column("Summary", width=SUMMARY_WIDTH)
        table.add_columns("Checked", "Result", "Missing", "Related")

    def action_refresh(self) -> None:
        table = self.query_one(DataTable)
        # Rows are rebuilt on every refresh; keep the cursor on the bug it was on.
        selected = self._selected_key(table)
        colors = self.app.theme_variables
        self._checks = {check.key: check for check in load_checks(self._db) if self._shown(check)}
        table.clear()
        day = None
        for key, check in self._checks.items():
            # Checks come latest first, so a day's checks sit together under one day row.
            if check.checked_at.date() != day:
                day = check.checked_at.date()
                table.add_row(Text(f"{day:%a %d %b}", style="bold"), key=f"day:{day}")
            table.add_row(*_row(check, colors), key=key)
        if selected in self._checks:
            table.move_cursor(row=table.get_row_index(selected))
        self.title = " · ".join(["All bugs", *self._narrowed_by()])

    def action_next_filter(self) -> None:
        self._filter = (self._filter + 1) % len(FILTERS)
        self.action_refresh()

    def action_search(self) -> None:
        search = self.query_one("#search", Input)
        search.display = True
        search.focus()

    def action_back(self) -> None:
        # Esc undoes the narrowest thing first: the search, then the filter, then the screen.
        search = self.query_one("#search", Input)
        if search.display:
            search.value = ""
            search.display = False
            self.query_one(DataTable).focus()
        elif self._filter:
            self._filter = 0
            self.action_refresh()
        else:
            self.app.pop_screen()

    def on_input_changed(self, event: Input.Changed) -> None:
        self.action_refresh()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.query_one(DataTable).focus()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        # A day row is a heading, not a bug: step over it the way the cursor was moving. The table
        # may have moved on since the event was sent, so look at where the cursor is now.
        table = event.data_table
        row = table.cursor_row
        if self._selected_key(table) in self._checks:
            self._last_row = row
            return
        step = 1 if row >= self._last_row else -1
        target = row + step if 0 <= row + step < table.row_count else row - step
        if 0 <= target < table.row_count:
            table.move_cursor(row=target)
        if target == 1:
            # Bringing the first bug into view scrolls its day row out of it; scroll back.
            table.call_after_refresh(table.scroll_home, animate=False)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.row_key.value in self._checks:
            self.app.push_screen(BugScreen(self._checks[event.row_key.value]))

    def _shown(self, check: Check) -> bool:
        query = self.query_one("#search", Input).value.strip().lower()
        haystack = " ".join([check.key, check.summary or "", check.reporter or ""]).lower()
        return (not query or query in haystack) and FILTERS[self._filter][1](check)

    def _narrowed_by(self) -> list[str]:
        query = self.query_one("#search", Input).value.strip()
        parts = [FILTERS[self._filter][0]] if self._filter else []
        return parts + [f"“{query}”"] if query else parts

    @staticmethod
    def _selected_key(table: DataTable) -> str | None:
        if not table.row_count:
            return None
        return table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value


def _row(check: Check, colors: dict[str, str]) -> tuple[str | Text, ...]:
    return (
        check.key,
        cut(check.summary or "", SUMMARY_WIDTH),
        f"{check.checked_at:%H:%M}",
        Text(result_label(check), style=colors[RESULT_COLORS[check.result]] if check.result in RESULT_COLORS else "dim"),
        " ".join(check.missing),
        str(len(check.related)) if check.related else "",
    )
