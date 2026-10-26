import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RECENT, ServiceLog, liveness } from '../../src/ui/service-log.ts';
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
    for (let i = 0; i < RECENT + 5; i++) text += logLine('check_start', ago((RECENT + 5 - i) * MINUTE, state.now), { key: `KAZ-${i}` }) + logLine('poll', state.now, { inQuery: 1 });
    writeFileSync(state.logFile, text);
    const log = new ServiceLog(state.logFile);
    log.read();
    assert.equal(log.recent.length, RECENT);
    assert.deepEqual([log.recent[0]?.fields.key, log.recent.at(-1)?.fields.key], ['KAZ-5', `KAZ-${RECENT + 4}`]);
    assert.ok(log.recent.every((e) => e.event === 'check_start'));
  });
});
