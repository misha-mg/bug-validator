"""The home screen's title: the name in large letters, blue fading to pink."""

from __future__ import annotations

from textual.color import Color
from textual.content import Content

# figlet's "ANSI Shadow" font.
ART = """\
██████╗ ██╗   ██╗ ██████╗     ██╗   ██╗ █████╗ ██╗     ██╗██████╗  █████╗ ████████╗ ██████╗ ██████╗
██╔══██╗██║   ██║██╔════╝     ██║   ██║██╔══██╗██║     ██║██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
██████╔╝██║   ██║██║  ███╗    ██║   ██║███████║██║     ██║██║  ██║███████║   ██║   ██║   ██║██████╔╝
██╔══██╗██║   ██║██║   ██║    ╚██╗ ██╔╝██╔══██║██║     ██║██║  ██║██╔══██║   ██║   ██║   ██║██╔══██╗
██████╔╝╚██████╔╝╚██████╔╝     ╚████╔╝ ██║  ██║███████╗██║██████╔╝██║  ██║   ██║   ╚██████╔╝██║  ██║
╚═════╝  ╚═════╝  ╚═════╝       ╚═══╝  ╚═╝  ╚═╝╚══════╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝"""


def banner(start: Color, end: Color, shadow: Color) -> Content:
    """The letters fade from start on the left to end on the right; their shadow lines are shadow."""
    lines = ART.splitlines()
    width = max(len(line) for line in lines)
    rows = []
    for line in lines:
        parts = []
        for column, char in enumerate(line):
            if char == " ":
                parts.append(char)
            elif char == "█":
                parts.append((char, start.blend(end, column / (width - 1)).hex))
            else:
                parts.append((char, shadow.hex))
        rows.append(Content.assemble(*parts))
    return Content("\n").join(rows)
