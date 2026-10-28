import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RECENT, ServiceLog, UNHEALTHY_POLL_FAILURES, health, liveness } from '../../src/ui/service-log.ts';
import { ago, appendLog, emptyState, logLine, sampleState } from './state.ts';

const MINUTE = 60 * 1000;

describe('ServiceLog', () => {
  it('reads the mode, the settings and the last poll', () => {
    const state = sampleState();
    const status = new ServiceLog(state.logFile).read();
    assert.ok(status);
    assert.deepEqual([status.dryRun, status.model, status.pollIntervalMs, status.claudeVersion, status.claudeAuth], [true, 'haiku', 180_000, '2.0.30', 'oauth_token']);
    assert.deepEqual([status.inQuery, status.waiting, status.pollError], [7, 2, null]);
    assert.equal(liveness(status, state.now), 'running');
  });
  it('reads only what was added and finishes a line cut in half', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', now, { dryRun: false, pollIntervalS: 60, model: 'sonnet' }));
    const log = new ServiceLog(state.logFile);
    assert.equal(log.read()?.dryRun, false);

    const failed = logLine('poll_failed', now, { error: 'Jira answered 503' });
    appendLog(state, `a stack trace, not JSON\n${failed.slice(0, 20)}`);
    assert.equal(log.read()?.pollError, null);
    appendLog(state, failed.slice(20));
    const status = log.read();
    assert.equal(status?.pollError, 'Jira answered 503');
    assert.equal(status?.dryRun, false);

    appendLog(state, logLine('poll', now, { inQuery: 3 }));
    assert.equal(log.read()?.pollError, null);
  });
  it('a log started again is read from the start', () => {
    const state = emptyState();
    writeFileSync(state.logFile, logLine('service_start', state.now, { dryRun: true, pollIntervalS: 180, model: 'haiku' }) + logLine('poll', state.now, { inQuery: 9 }));
    const log = new ServiceLog(state.logFile);
    assert.equal(log.read()?.inQuery, 9);
    assert.equal(log.recent.length, 1);

    writeFileSync(state.logFile, logLine('poll', state.now, { inQuery: 2 }));
    const status = log.read();
    assert.deepEqual([status?.inQuery, status?.dryRun], [2, null]);
    assert.equal(log.recent.length, 0);
  });
  it('stopped or silent is not running; no log is no status', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', ago(60 * MINUTE, now), { dryRun: true, pollIntervalS: 180 }) + logLine('poll', ago(12 * MINUTE, now)));
    assert.equal(liveness(new ServiceLog(state.logFile).read()!, now), 'silent');
    appendLog(state, logLine('service_stopped', now));
    assert.equal(liveness(new ServiceLog(state.logFile).read()!, now), 'stopped');
    assert.equal(new ServiceLog(join(state.dir, 'missing.log')).read(), null);
  });
  it('keeps the latest events other than polls', () => {
    const state = emptyState();
    let text = '';
    for (let i = 0; i < RECENT + 5; i++) {
      text += logLine('check_start', ago((RECENT + 5 - i) * MINUTE, state.now), { key: `KAZ-${i}` });
      text += logLine('comment_dry_run', ago((RECENT + 5 - i) * MINUTE, state.now), { key: `KAZ-${i}`, missing: ['R1'] }) + logLine('poll', state.now, { inQuery: 1 });
    }
    writeFileSync(state.logFile, text);
    const log = new ServiceLog(state.logFile);
    assert.equal(log.read()?.checking, null);
    assert.equal(log.recent.length, RECENT);
    assert.deepEqual([log.recent[0]?.fields.key, log.recent.at(-1)?.fields.key], ['KAZ-5', `KAZ-${RECENT + 4}`]);
    assert.ok(log.recent.every((e) => e.event === 'comment_dry_run'));
  });
  it('knows the bug being checked until its check ends', () => {
    const state = emptyState();
    writeFileSync(state.logFile, logLine('check_start', ago(MINUTE, state.now), { key: 'KAZ-7' }));
    const log = new ServiceLog(state.logFile);
    assert.deepEqual(log.read()?.checking, { key: 'KAZ-7', since: ago(MINUTE, state.now) });
    appendLog(state, logLine('check_failed', state.now, { key: 'KAZ-7', error: 'boom' }));
    assert.equal(log.read()?.checking, null);
  });
  it('a start that ends in fatal is crashed, even while systemd keeps starting it; a stop under way is stopping', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', ago(5 * MINUTE, now), { dryRun: true }) + logLine('fatal', ago(MINUTE, now), { error: 'Bad configuration' }) + logLine('fatal', now, { error: 'Bad configuration' }));
    const log = new ServiceLog(state.logFile);
    const crashed = log.read()!;
    assert.equal(liveness(crashed, now), 'crashed');
    assert.equal(crashed.crashed, 'Bad configuration');
    appendLog(state, logLine('service_start', now, { dryRun: true }) + logLine('check_start', now, { key: 'KAZ-1' }) + logLine('service_stopping', now, { signal: 'SIGTERM' }));
    assert.equal(liveness(log.read()!, now), 'stopping');
    appendLog(state, logLine('service_stopped', now) + logLine('service_start', now, { dryRun: true }));
    const restarted = log.read()!;
    assert.equal(liveness(restarted, now), 'running');
    assert.equal(restarted.checking, null, 'a start ends a check the crash or the stop cut short');
  });
  it('is unhealthy when the service is not running or its polls keep failing', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', now, { dryRun: true, pollIntervalS: 180 }));
    const log = new ServiceLog(state.logFile);
    assert.equal(health(log.read(), now).ok, true);
    for (let i = 0; i < UNHEALTHY_POLL_FAILURES; i++) appendLog(state, logLine('poll_failed', now, { error: 'fetch failed' }));
    assert.deepEqual(health(log.read(), now), { ok: false, state: 'running', pollFailures: UNHEALTHY_POLL_FAILURES, lastSeen: now.toISOString() });
    appendLog(state, logLine('poll', now, { inQuery: 1 }));
    assert.equal(health(log.read(), now).ok, true);
    assert.equal(health(null, now).state, 'no_log');
  });
  it('waits out an agent timeout longer than the default before calling the service silent', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', ago(30 * MINUTE, now), { dryRun: true, pollIntervalS: 180, agentTimeoutS: 900 }) + logLine('check_start', ago(14 * MINUTE, now), { key: 'KAZ-1' }));
    assert.equal(liveness(new ServiceLog(state.logFile).read()!, now), 'running');
  });
  it('after the log is cut, reads the cut part first, so the start is still known', () => {
    const state = emptyState();
    const now = state.now;
    writeFileSync(state.logFile, logLine('service_start', now, { dryRun: false, model: 'haiku' }) + logLine('poll', now, { inQuery: 4 }));
    const log = new ServiceLog(state.logFile);
    assert.equal(log.read()?.dryRun, false);
    writeFileSync(`${state.logFile}.1`, readFileSync(state.logFile));
    writeFileSync(state.logFile, '');
    appendLog(state, logLine('poll', now, { inQuery: 5 }));
    const status = log.read();
    assert.deepEqual([status?.dryRun, status?.inQuery], [false, 5]);
  });
  it('joins a character split between two reads', () => {
    const state = emptyState();
    const line = Buffer.from(logLine('poll_failed', state.now, { error: 'Jira: ошибка' }));
    const cut = line.indexOf(Buffer.from('ш')) + 1; // inside the two bytes of "ш"
    writeFileSync(state.logFile, line.subarray(0, cut));
    const log = new ServiceLog(state.logFile);
    log.read();
    appendFileSync(state.logFile, line.subarray(cut));
    assert.equal(log.read()?.pollError, 'Jira: ошибка');
  });
});
