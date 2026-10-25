import asyncio
from io import StringIO
from pathlib import Path

from rich.console import Console
from textual.widgets import DataTable, Static

from bug_validator_tui.app import ValidatorApp
from bug_validator_tui.bug_view import BugScreen
from bug_validator_tui.bugs import BugsScreen
from bug_validator_tui.chart import DayChart
from bug_validator_tui.home import HomeScreen


def text_of(widget: Static, width: int = 120) -> str:
    """The widget's text as a terminal would show it."""
    console = Console(width=width, record=True, file=StringIO())
    console.print(widget.content)
    return console.export_text()


def cells(table: DataTable) -> list[list[str]]:
    return [[str(cell) for cell in table.get_row_at(i)] for i in range(table.row_count)]


def test_home_shows_the_service_the_statistics_and_the_gaps(state: Path) -> None:
    async def scenario() -> None:
        app = ValidatorApp(state)
        async with app.run_test(size=(170, 50)):
            screen = app.screen
            assert isinstance(screen, HomeScreen)
            assert "██╗" in text_of(screen.query_one("#banner", Static))
            service = text_of(screen.query_one("#service", Static))
            # A label column of 10, a gap of 3, then the value.
            rows = {line[:10].strip(): line[13:].strip() for line in service.splitlines() if line.strip()}
            assert rows["State"] == "running"
            assert rows["Last poll"] == "1m ago"
            assert rows["Mode"] == "dry run"
            assert rows["In Created"] == "7"
            assert rows["Skipped"].startswith("1 · ")
            assert "Poll every" not in rows

            stats = text_of(screen.query_one("#stats", Static))
            assert "Today" in stats and "7 days" in stats and "All time" in stats
            assert "With comment" in stats and "67% (2)" in stats

            problems = text_of(screen.query_one("#problems", Static)).splitlines()
            assert "R6" in problems[0] and "HAR file" in problems[0] and "67% (2)" in problems[0]
            assert screen.query_one("#problems").border_subtitle == "of 3 bugs checked · all time"

            attention = cells(screen.query_one("#attention", DataTable))
            assert [(row[0], row[2], row[3]) for row in attention] == [("RPG-4", "3 of 3, gave up", "Error: agent run timed out")]
            assert not screen.query_one("#all-clear").display

    asyncio.run(scenario())


def test_the_chart_shows_as_many_days_as_fit(state: Path) -> None:
    async def scenario(width: int) -> tuple[int, int, int]:
        app = ValidatorApp(state)
        async with app.run_test(size=(width, 50)) as pilot:
            await pilot.pause()
            chart = app.screen.query_one(DayChart)
            lines = chart.render().plain.splitlines()
            return len(lines[-2].split()), max(len(line) for line in lines), chart.size.width

    assert asyncio.run(scenario(170))[0] == 30
    days, longest, width = asyncio.run(scenario(110))
    assert days < 30 and longest <= width


def test_home_opens_a_failed_check(state: Path) -> None:
    async def scenario() -> None:
        app = ValidatorApp(state)
        async with app.run_test(size=(170, 50)) as pilot:
            app.screen.query_one("#attention", DataTable).focus()
            await pilot.press("enter")
            await pilot.pause()
            assert isinstance(app.screen, BugScreen)
            summary = text_of(app.screen.query_one("#summary", Static))
            assert "check failed" in summary and "Error: agent run timed out" in summary
            assert "the check did not finish" in text_of(app.screen.query_one("#comment", Static))

    asyncio.run(scenario())


def test_bugs_are_listed_by_day_with_their_result(state: Path) -> None:
    async def scenario() -> None:
        app = ValidatorApp(state)
        async with app.run_test(size=(170, 50)) as pilot:
            await pilot.press("b")
            await pilot.pause()
            assert isinstance(app.screen, BugsScreen)
            table = app.screen.query_one(DataTable)
            rows = cells(table)
            bugs = [row for row in rows if row[0][:3] in ("KAZ", "RPG")]

            # Every bug under its day's row, the latest first.
            assert len(rows) == 10
            assert [row[0] for row in bugs] == ["KAZ-2", "RPG-4", "KAZ-3", "KAZ-5", "KAZ-1"]
            assert bugs[0][1:2] + bugs[0][3:] == ["Ports table is empty after clearing the filter", "comment · dry run", "R4 R6", "1"]
            assert bugs[2][3] == "no comment" and bugs[4][3] == "skipped"
            # The cursor starts on the first bug, not on its day row.
            assert table.cursor_row == 1

            await pilot.press("f")
            await pilot.pause()
            assert [row[0] for row in cells(table) if row[0][:3] in ("KAZ", "RPG")] == ["KAZ-2", "KAZ-5"]
            assert app.screen.title == "All bugs · with comment"
            await pilot.press("escape")
            await pilot.pause()
            assert table.row_count == 10

            await pilot.press("slash")
            await pilot.press(*"login")
            await pilot.pause()
            assert [row[0] for row in cells(table) if row[0][:3] in ("KAZ", "RPG")] == ["KAZ-3"]

    asyncio.run(scenario())


def test_a_bug_shows_the_comment_and_what_it_asks_for(state: Path) -> None:
    async def scenario() -> None:
        app = ValidatorApp(state)
        async with app.run_test(size=(170, 50)) as pilot:
            await pilot.press("b")
            await pilot.pause()
            await pilot.press("enter")
            await pilot.pause()
            screen = app.screen
            assert isinstance(screen, BugScreen)
            summary = text_of(screen.query_one("#summary", Static))
            assert "KAZ-2 · Ports table is empty after clearing the filter" in summary
            assert "A Tester" in summary
            assert "https://cgstowernetworks.atlassian.net/browse/KAZ-2" in summary

            comment = text_of(screen.query_one("#comment", Static))
            assert comment.splitlines()[:2] == ["@A Tester", "Please add:"]
            assert screen.query_one("#comment-block").border_subtitle == "dry run · not posted"

            requirements = text_of(screen.query_one("#requirements Static", Static)).splitlines()
            r6 = next(line for line in requirements if line.startswith("R6"))
            assert "missing" in r6 and "✗ detail of R6" in r6
            assert any(line.startswith("KAZ-1") and "the same empty table" in line for line in requirements)

            await pilot.press("escape")
            await pilot.pause()
            assert isinstance(app.screen, BugsScreen)

    asyncio.run(scenario())
