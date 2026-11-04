import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Attachment, Bug, RunFile } from '../domain/bug.ts'
import { cleanHar } from '../domain/har.ts'
import { type Jira, JiraError } from '../jira/client.ts'

/** Over this nothing is downloaded: a dump or a recording the agent would not get through. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/** A video as frames: one every 2 seconds, at most 30 — a minute of screen. */
const FRAME_EVERY_S = 2
const MAX_FRAMES = 30
const FFMPEG_TIMEOUT_MS = 120_000

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'])
const TEXT = new Set(['.txt', '.log', '.json', '.csv', '.md', '.xml', '.yaml', '.yml', '.html'])

/**
 * The run's files from the bug's attachments, in `dir` (which must exist): images as they are, a
 * HAR cleaned (domain/har.ts), a video as frames, text as it is. A download Jira fails is a
 * failed read and is thrown; a file the reporter made that cannot be read as its kind — a HAR
 * that is not JSON, a video ffmpeg cannot open — is `unread` with the reason, and the agent may
 * ask for it. The list keeps the attachments' order.
 */
export async function prepareFiles(jira: Pick<Jira, 'attachment'>, bug: Bug, dir: string): Promise<RunFile[]> {
  const files: RunFile[] = []
  for (const a of bug.attachments) {
    const kind = kindOf(a)
    const unread = (note: string): number => files.push({ filename: a.filename, path: '', kind: 'unread', note })
    if (kind === null) {
      unread(`${a.mimeType || extname(a.filename) || 'unknown type'}: not a kind the agent reads`)
      continue
    }
    if (a.size > MAX_ATTACHMENT_BYTES) {
      unread(`${mb(a.size)} MB, over the ${mb(MAX_ATTACHMENT_BYTES)} MB limit`)
      continue
    }
    const name = `${a.id}-${a.filename.replace(/[^\w.-]+/g, '_')}`
    const path = join(dir, name)
    try {
      await pipeline(Readable.fromWeb(await jira.attachment(a.id)), createWriteStream(path))
    } catch (err) {
      // A stream cut short (a reset, the download's timeout) is a read that failed, like one Jira refused.
      if (err instanceof JiraError) throw err
      throw new JiraError(`download of ${a.filename} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (kind === 'image' || kind === 'text') {
      files.push({ filename: a.filename, path: name, kind, note: `${kb(a.size)} KB` })
    } else if (kind === 'har') {
      try {
        await writeFile(path, cleanHar(await readFile(path, 'utf8')))
        files.push({ filename: a.filename, path: name, kind, note: 'cookies, tokens and binary bodies removed' })
      } catch (err) {
        await rm(path, { force: true })
        unread(`not a HAR file: ${(err as Error).message.slice(0, 120)}`)
      }
    } else {
      const framesDir = `${name}-frames`
      const result = await frames(path, join(dir, framesDir))
      await rm(path, { force: true })
      if (typeof result === 'number')
        files.push({ filename: a.filename, path: framesDir, kind: 'frames', note: `${result} frames, one every ${FRAME_EVERY_S} s` })
      else unread(`ffmpeg could not read the video: ${result}`)
    }
  }
  return files
}

function kindOf(a: Attachment): 'image' | 'har' | 'video' | 'text' | null {
  const ext = extname(a.filename).toLowerCase()
  if (ext === '.har') return 'har'
  if (IMAGE.has(ext) || a.mimeType.startsWith('image/')) return 'image'
  if (VIDEO.has(ext) || a.mimeType.startsWith('video/')) return 'video'
  if (TEXT.has(ext) || a.mimeType.startsWith('text/')) return 'text'
  return null
}

/** The video's frames as JPEGs in `outDir`: how many, or ffmpeg's complaint. */
async function frames(video: string, outDir: string): Promise<number | string> {
  await mkdir(outDir)
  const args = [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    video,
    '-vf',
    `fps=1/${FRAME_EVERY_S}`,
    '-frames:v',
    String(MAX_FRAMES),
    '-q:v',
    '3',
    join(outDir, '%02d.jpg'),
  ]
  const complaint = await new Promise<string | null>((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS)
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(e.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? null : (err.trim().split('\n').pop() ?? `exit ${code}`).slice(0, 200))
    })
  })
  if (complaint !== null) {
    await rm(outDir, { recursive: true, force: true })
    return complaint
  }
  const count = (await readdir(outDir)).length
  if (count === 0) {
    await rm(outDir, { recursive: true, force: true })
    return 'no frames'
  }
  return count
}

const kb = (bytes: number): number => Math.max(1, Math.round(bytes / 1024))
const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
