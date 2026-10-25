"""Screens over files that change while the app is open."""

from __future__ import annotations

from textual.screen import Screen


class LiveScreen(Screen):
    """Reloads its data when shown, on `r`, and when the app's timer asks it to."""

    BINDINGS = [("r", "refresh", "Refresh")]

    def on_screen_resume(self) -> None:
        self.action_refresh()

    def action_refresh(self) -> None:
        raise NotImplementedError
