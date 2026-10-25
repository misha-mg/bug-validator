"""The app's colors: cold, with blue for frames, green beside it and pink for accents.

Pink is the color of a comment; the red of errors is darker and more saturated, so the two tell
apart in the chart.
"""

from textual.theme import Theme

COLD = Theme(
    name="bug-validator-cold",
    primary="#7aa2f7",
    secondary="#73daca",
    accent="#f5a3c8",
    warning="#e0af68",
    error="#e5484d",
    success="#9ece6a",
    foreground="#c0caf5",
    background="#1a1b26",
    surface="#222436",
    panel="#2f334d",
    dark=True,
)
