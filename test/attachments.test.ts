import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Attachment } from '../src/domain/bug.ts';
import { JiraError } from '../src/jira/client.ts';
import { MAX_ATTACHMENT_BYTES, prepareFiles } from '../src/pipeline/attachments.ts';
import { bug } from './fixtures.ts';

const bytes = (data: Uint8Array | string) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : data), c.close()) });
const att = (id: string, filename: string, mimeType = '', size = 100): Attachment => ({ id, filename, size, mimeType });

describe('prepareFiles', () => {
  let work: string;
  let video: Uint8Array;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'bv-att-'));
    // Three seconds of a test pattern: real video, no fixture to keep.
    const file = join(work, 'in.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5', '-t', '3', '-pix_fmt', 'yuv420p', file]);
    video = readFileSync(file);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('images and text as they are, a HAR cleaned, a video as frames, in the attachments\' order', async () => {
    const dir = mkdtempSync(join(work, 'run-'));
    const har = readFileSync(new URL('./fixtures/session.har', import.meta.url), 'utf8');
    const content: Record<string, Uint8Array | string> = { '1': new Uint8Array([137, 80, 78, 71]), '2': har, '3': video, '4': 'a log line' };
    const jira = { attachment: async (id: string) => bytes(content[id]!) };
    const b = bug('KAZ-9025', { attachments: [att('1', 'Screen shot.png', 'image/png'), att('2', 'session.har'), att('3', 'rec.mp4', 'video/mp4'), att('4', 'app.log')] });
    const files = await prepareFiles(jira, b, dir);
    assert.deepEqual(files.map((f) => [f.filename, f.kind, f.path]), [
      ['Screen shot.png', 'image', '1-Screen_shot.png'],
      ['session.har', 'har', '2-session.har'],
      ['rec.mp4', 'frames', '3-rec.mp4-frames'],
      ['app.log', 'text', '4-app.log'],
    ]);
    assert.deepEqual([...readFileSync(join(dir, '1-Screen_shot.png'))], [137, 80, 78, 71]);
    assert.equal(readFileSync(join(dir, '2-session.har'), 'utf8').includes('hunter2'), false, 'the HAR is the cleaned one');
    const frames = readdirSync(join(dir, '3-rec.mp4-frames'));
    assert.equal(frames.length, 2, 'one frame every 2 s of 3 s');
    assert.equal(existsSync(join(dir, '3-rec.mp4')), false, 'the video itself is not kept');
    assert.match(files[2]!.note, /^2 frames/);
  });
  it('a file the reporter made unreadable, an unknown kind, or one over the limit is listed, not an error', async () => {
    const dir = mkdtempSync(join(work, 'run-'));
    const jira = { attachment: async () => bytes('not json at all') };
    const b = bug('KAZ-9025', { attachments: [att('5', 'broken.har'), att('6', 'clip.mp4', 'video/mp4'), att('7', 'dump.bin'), att('8', 'big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)] });
    const files = await prepareFiles(jira, b, dir);
    assert.deepEqual(files.map((f) => f.kind), ['unread', 'unread', 'unread', 'unread']);
    assert.match(files[0]!.note, /^not a HAR file/);
    assert.match(files[1]!.note, /^ffmpeg could not read the video/);
    assert.match(files[2]!.note, /not a kind the agent reads/);
    assert.match(files[3]!.note, /over the 50 MB limit/);
    assert.deepEqual(readdirSync(dir), [], 'nothing unread is left behind');
  });
  it('a download Jira fails, or one cut short, is a failed read of the surroundings\' kind', async () => {
    const dir = mkdtempSync(join(work, 'run-'));
    const refused = { attachment: async () => Promise.reject(new JiraError('HTTP 503', 503)) };
    await assert.rejects(prepareFiles(refused, bug('KAZ-9025', { attachments: [att('9', 'x.png', 'image/png')] }), dir), (err: JiraError) => err.status === 503);
    const cut = { attachment: async () => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array([1])), c.error(new Error('The operation was aborted'))) }) };
    await assert.rejects(prepareFiles(cut, bug('KAZ-9025', { attachments: [att('9', 'x.png', 'image/png')] }), dir), (err: JiraError) => err.name === 'JiraError' && err.environmental && /download of x\.png failed: The operation was aborted/.test(err.message));
  });
});
