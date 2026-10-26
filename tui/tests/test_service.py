from datetime import datetime, timedelta
from pathlib import Path

from conftest import log_line
from bug_validator_tui.service import Liveness, ServiceLog, liveness


def test_reads_the_mode_and_the_last_poll(state: Path) -> None:
    status = ServiceLog(state / "service.log").read()

    assert status is not None
    assert (status.dry_run, status.model, status.poll_interval) == (True, "haiku", timedelta(minutes=3))
    assert (status.in_query, status.waiting, status.poll_error) == (7, 2, None)
    assert liveness(status, datetime.now()) is Liveness.RUNNING


def test_reads_only_what_was_added_and_finishes_a_line_cut_in_half(tmp_path: Path) -> None:
    path = tmp_path / "service.log"
    now = datetime.now()
    path.write_text(log_line("service_start", now, dryRun=False, pollIntervalS=60, model="sonnet"))
    log = ServiceLog(path)
    assert log.read().dry_run is False

    failed = log_line("poll_failed", now, error="Jira answered 503")
    with path.open("a") as f:
        f.write("a stack trace, not JSON\n" + failed[:20])
    assert log.read().poll_error is None
    with path.open("a") as f:
        f.write(failed[20:])
    status = log.read()
    assert status.poll_error == "Jira answered 503" and status.dry_run is False

    with path.open("a") as f:
        f.write(log_line("poll", now, inQuery=3))
    assert log.read().poll_error is None


def test_a_log_started_again_is_read_from_the_start(tmp_path: Path) -> None:
    path = tmp_path / "service.log"
    now = datetime.now()
    path.write_text(log_line("service_start", now, dryRun=True, pollIntervalS=180, model="haiku") + log_line("poll", now, inQuery=9))
    log = ServiceLog(path)
    assert log.read().in_query == 9

    path.write_text(log_line("poll", now, inQuery=2))
    status = log.read()
    assert status.in_query == 2 and status.dry_run is None


def test_stopped_or_silent_is_not_running(tmp_path: Path) -> None:
    path = tmp_path / "service.log"
    now = datetime.now()
    path.write_text(log_line("service_start", now - timedelta(hours=1), dryRun=True, pollIntervalS=180) + log_line("poll", now - timedelta(minutes=12)))
    assert liveness(ServiceLog(path).read(), now) is Liveness.SILENT

    with path.open("a") as f:
        f.write(log_line("service_stopped", now))
    assert liveness(ServiceLog(path).read(), now) is Liveness.STOPPED
    assert ServiceLog(tmp_path / "missing.log").read() is None
