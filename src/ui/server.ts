import { existsSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { ISSUE_KEY } from '../domain/key.ts';
import { describeError, log } from '../log.ts';
import type { UiConfig } from './config.ts';
import { requestCheck } from '../pipeline/requests.ts';
import { type PageContext, bugPage, bugsPage, bugsQuery, errorPage, homePage } from './html.ts';
import { readBug, readBugs, readRequests } from './read.ts';
import { ServiceLog } from './service-log.ts';

const STATIC: Record<string, string> = { '/app.css': 'text/css', '/app.js': 'text/javascript', '/theme.js': 'text/javascript' };
/** The Barlow faces the stylesheet names, under static/fonts. */
const FONT = /^\/fonts\/[a-z0-9-]+\.woff2$/;

/** A posted form is small; anything bigger is not one. */
const MAX_BODY = 4096;

/**
 * The web UI: three pages rendered from the database and the log on every request, plus the
 * stylesheet, its fonts and the scripts. Nothing is cached: an edit to a static file shows on reload,
 * and the pages are always what the files say now. The one write is `POST /requests`: a check
 * asked for by hand, which the service serves.
 */
export function startUi(config: UiConfig, host = config.host, port = config.port): Promise<Server> {
  // One reader lives for the server's life: it reads the log incrementally.
  const serviceLog = new ServiceLog(config.logFile);
  const server = createServer((req, res) => {
    handle(req, res, config, serviceLog).catch((err: unknown) => {
      log.error('ui_error', { url: req.url, error: describeError(err) });
      const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: null, now: new Date() };
      send(res, 500, 'text/html', errorPage(500, describeError(err), ctx));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: UiConfig, serviceLog: ServiceLog): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const type = STATIC[path] ?? (FONT.test(path) ? 'font/woff2' : undefined);
  if (type) {
    const file = new URL(`./static${path}`, import.meta.url);
    if (existsSync(file)) send(res, 200, type, readFileSync(file));
    else send(res, 404, 'text/plain', `No file at ${path}.`);
    return;
  }
  const status = serviceLog.read();
  const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: status?.dryRun ?? null, now: new Date() };
  if (req.method === 'POST' && path === '/requests') {
    const form = new URLSearchParams(await body(req));
    try {
      const key = requestCheck(config.dbFile, form.get('key') ?? '');
      res.writeHead(303, { Location: `/bugs/${key}` });
      res.end();
    } catch (err) {
      send(res, 400, 'text/html', errorPage(400, err instanceof Error ? err.message : String(err), ctx));
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain', 'GET only');
    return;
  }
  if (path === '/') {
    send(res, 200, 'text/html', homePage({ bugs: readBugs(config.dbFile), status, logPath: config.logFile, recent: serviceLog.recent, requests: readRequests(config.dbFile) }, ctx));
  } else if (path === '/bugs') {
    send(res, 200, 'text/html', bugsPage(readBugs(config.dbFile), bugsQuery(url.searchParams), ctx));
  } else if (path.startsWith('/bugs/')) {
    const key = path.slice('/bugs/'.length);
    if (!ISSUE_KEY.test(key)) {
      send(res, 400, 'text/html', errorPage(400, `Not a KAZ or RPG key: ${key}`, ctx));
      return;
    }
    const bug = readBug(config.dbFile, key);
    const request = readRequests(config.dbFile).find((r) => r.key === key) ?? null;
    if (!bug && !request) send(res, 404, 'text/html', errorPage(404, `${key} is not in the database.`, ctx));
    else send(res, 200, 'text/html', bugPage({ key, bug, request }, ctx));
  } else {
    send(res, 404, 'text/html', errorPage(404, `No page at ${path}.`, ctx));
  }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_BODY) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(body);
}
