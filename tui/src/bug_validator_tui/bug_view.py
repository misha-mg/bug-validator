"""One bug on its own screen."""

from __future__ import annotations

from rich.console import Group, RenderableType
from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.content import Content
from textual.screen import Screen
from textual.widgets import Footer, Header, Static

from .checks import REQUIREMENTS, Check, Result
from .fmt import RESULT_COLORS, comment_text, result_label

SKIPPED = "Skipped: the bug was already in Created when the service first started, so it was never checked."


class BugScreen(Screen):
    """One bug: what is known about it on top, its requirements on the left, the comment on the right."""

    BINDINGS = [("escape", "app.pop_screen", "Back")]
    DEFAULT_CSS = """
    BugScreen #summary { padding: 1 2; border-bottom: solid $primary; height: auto; }
    BugScreen .block { border: round $primary; padding: 1 2; height: 1fr; }
    BugScreen .block { width: 1fr; }
    """

    def __init__(self, check: Check) -> None:
        super().__init__()
        self._check = check

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(_summary(self._check, self.app.jira_url), id="summary")
        with Horizontal():
            with VerticalScroll(id="requirements", classes="block"):
                yield Static(_requirements(self._check, self.app.theme_variables))
            with VerticalScroll(id="comment-block", classes="block"):
                yield Static(_comment(self._check), id="comment")
        yield Footer()

    def on_mount(self) -> None:
        self.title = self._check.key
        self.query_one("#requirements").border_title = "Requirements"
        block = self.query_one("#comment-block")
        block.border_title = "Comment"
        if self._check.status == "dry_run":
            block.border_subtitle = "dry run · not posted"
        elif self._check.status == "commented":
            block.border_subtitle = "posted to Jira"
        elif self._check.status == "posting":
            block.border_subtitle = "interrupted while posting · look in Jira"


def _summary(check: Check, jira_url: str) -> Content:
    rows: list[tuple[str, Content | str]] = [
        ("Bug", f"{check.key} · {check.summary}" if check.summary else check.key),
    ]
    if check.reporter:
        rows.append(("Reporter", check.reporter))
    color = RESULT_COLORS.get(check.result)
    rows.append(("Result", Content.styled(result_label(check), f"${color}" if color else "dim")))
    rows.append(("Checked", f"{check.checked_at:%d %b %H:%M}"))
    if check.error:
        rows.append(("Error", Content.styled(check.error, "$error")))
    rows.append(("Jira", f"{jira_url.rstrip('/')}/browse/{check.key}"))
    return Content("\n").join(Content.assemble((f"{label:<10}", "bold"), "   ", value) for label, value in rows)


def _requirements(check: Check, colors: dict[str, str]) -> RenderableType:
    if not check.checked and check.status != "posting":
        return "The check did not finish." if check.result is Result.ERROR else "Never checked."
    base = {b.id: b for b in check.base_checks}
    table = Table.grid(padding=(0, 2), expand=True)
    table.add_column(no_wrap=True, width=2)
    table.add_column(no_wrap=True, width=18)
    table.add_column(no_wrap=True, width=7)
    table.add_column(no_wrap=True, overflow="ellipsis", ratio=1)
    # The agent's verdict decides what the comment asks for; the base checks are the facts it was
    # given, and it may overrule them (steps written without a "Steps" heading are still steps).
    table.add_row("", "", Text("Agent", style="bold"), Text("Base check", style="bold"))
    for id, name in REQUIREMENTS.items():
        verdict = Text("missing", style=f"bold {colors['accent']}") if id in check.missing else Text("ok", style=colors["success"])
        found = base.get(id)
        fact = Text("")
        if found:
            fact.append("✓ " if found.passed else "✗ ", style=colors["success"] if found.passed else colors["error"])
            fact.append(found.detail, style="dim")
        table.add_row(Text(id, style="bold"), name, verdict, fact)
    if not check.related:
        return table
    # Their own grid: a reason runs to two lines rather than being cut.
    related = Table.grid(padding=(0, 2))
    related.add_column(no_wrap=True)
    related.add_column()
    for bug in check.related:
        related.add_row(Text(bug.key, style="bold"), Text(bug.reason, style="dim"))
    return Group(table, Text(""), Text("Related bugs", style=f"bold {colors['secondary']}"), related)


def _comment(check: Check) -> str:
    if check.result is Result.SKIPPED:
        return SKIPPED
    if check.status == "posting":
        return "The service stopped while posting this comment. Look in Jira: if it is not there, requeue the bug.\n\n" + comment_text(check.comment or "", check.reporter)
    if check.result is Result.ERROR:
        return "No comment: the check did not finish."
    if not check.comment:
        return "Nothing is missing, so the bug got no comment."
    return comment_text(check.comment, check.reporter)
