import argparse
import os
from pathlib import Path

from .app import JIRA_URL, ValidatorApp


def main() -> None:
    parser = argparse.ArgumentParser(prog="bug-validator-tui", description="Watch the bug validator.")
    parser.add_argument(
        "state",
        nargs="?",
        type=Path,
        default=Path("state"),
        help="the service's state directory, with its database and log (default: ./state)",
    )
    args = parser.parse_args()
    if not args.state.is_dir():
        parser.error(f"not a directory: {args.state}")
    ValidatorApp(args.state.resolve(), os.environ.get("JIRA_BASE_URL", JIRA_URL)).run()


if __name__ == "__main__":
    main()
