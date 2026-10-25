"""The service's state from its log: whether it runs, its mode, and how the last poll went."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path

from .checks import local_time

# config.ts's default, for a log that starts after the service did.
DEFAULT_INTERVAL = timedelta(minutes=3)
# A poll that checks bugs logs nothing while the agent runs, up to its timeout (3 minutes).
AGENT_MARGIN = timedelta(minutes=5)


@dataclass(frozen=True)
class ServiceStatus:
    # From the latest service_start; None when the log does not reach back to it.
    started: datetime | None = None
    dry_run: bool | None = None
    model: str | None = None
    poll_interval: timedelta | None = None
    stopped: bool = False
    # The latest line of any kind.
    last_seen: datetime | None = None
    last_poll: datetime | None = None
    in_query: int | None = None
    # The latest poll's error, when it failed.
    poll_error: str | None = None


class Liveness(Enum):
    RUNNING = "running"
    STOPPED = "stopped"
    SILENT = "silent"


def liveness(status: ServiceStatus, now: datetime) -> Liveness:
    """Stopped when it said so; silent when it has written nothing for two polls and an agent run."""
    if status.stopped:
        return Liveness.STOPPED
    interval = status.poll_interval or DEFAULT_INTERVAL
    if status.last_seen is None or now - status.last_seen > 2 * interval + AGENT_MARGIN:
        return Liveness.SILENT
    return Liveness.RUNNING


class ServiceLog:
    """state/service.log, one JSON line per event (src/log.ts), read as it grows: each read takes
    only the lines added since the last one."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._offset = 0
        # The end of the file when it ends mid-line: the rest of the line comes with the next read.
        self._partial = b""
        self._status = ServiceStatus()

    def read(self) -> ServiceStatus | None:
        """The status as of the log's last line; None when there is no log."""
        if not self.path.is_file():
            return None
        if self.path.stat().st_size < self._offset:
            # Rotated or emptied: read it again from the start.
            self._offset, self._partial, self._status = 0, b"", ServiceStatus()
        with self.path.open("rb") as log:
            log.seek(self._offset)
            added = log.read()
        self._offset += len(added)
        *lines, self._partial = (self._partial + added).split(b"\n")
        for line in lines:
            self._status = _take(self._status, line)
        return self._status


def _take(status: ServiceStatus, line: bytes) -> ServiceStatus:
    try:
        event = json.loads(line)
        ts = local_time(event["ts"])
    except (ValueError, KeyError, TypeError):
        # Not one of the service's lines: a crash's stack trace, say.
        return status
    status = replace(status, last_seen=ts)
    name = event.get("event")
    if name == "service_start":
        interval = event.get("pollIntervalS")
        return replace(
            status,
            started=ts,
            dry_run=event.get("dryRun"),
            model=event.get("model"),
            poll_interval=timedelta(seconds=interval) if interval else None,
            stopped=False,
        )
    if name == "service_stopped":
        return replace(status, stopped=True)
    if name == "poll":
        return replace(status, last_poll=ts, in_query=event.get("inQuery"), poll_error=None)
    if name == "poll_failed":
        return replace(status, last_poll=ts, poll_error=event.get("error") or "unknown error")
    return status
