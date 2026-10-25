"""The terminal UI: the home screen first, every bug and each bug's comment a key away."""

from __future__ import annotations

from pathlib import Path

from textual.app import App

from .home import HomeScreen
from .live import LiveScreen
from .service import ServiceLog
from .theme import COLD

REFRESH_SECONDS = 5
JIRA_URL = "https://cgstowernetworks.atlassian.net"


class ValidatorApp(App):
    TITLE = "Bug validator"
    BINDINGS = [("q", "quit", "Quit")]

    def __init__(self, state: Path, jira_url: str = JIRA_URL) -> None:
        super().__init__()
        self.sub_title = str(state)
        # The service's files: src/config.ts (DB_FILE) and deploy/bug-validator.service.
        self._db = state / "bug-validator.sqlite"
        self._service_log = ServiceLog(state / "service.log")
        # The bug screen links each bug to Jira.
        self.jira_url = jira_url

    def get_default_screen(self) -> HomeScreen:
        return HomeScreen(self._db, self._service_log)

    def on_mount(self) -> None:
        self.register_theme(COLD)
        self.theme = COLD.name
        self.set_interval(REFRESH_SECONDS, self._refresh_screen)

    def _refresh_screen(self) -> None:
        # Only the screen on show reloads; one underneath reloads when it is shown again.
        if isinstance(self.screen, LiveScreen):
            self.screen.action_refresh()
