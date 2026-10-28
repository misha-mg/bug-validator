import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { requestCheck } from '../db/store.ts';
import { ISSUE_KEY } from '../domain/key.ts';
import { describeError, log } from '../log.ts';
import type { UiConfig } from './config.ts';
import { type PageContext, bugPage, bugsPage, bugsQuery, errorPage, homePage } from './html.ts';
import { readBug, readBugs, readRequests } from './read.ts';
import { health, ServiceLog } from './service-log.ts';

const STATIC: Record<string, string> = { '/sheet.css': 'text/css', '/app.css': 'text/css', '/app.js': 'text/javascript', '/theme.js': 'text/javascript' };
/** The Barlow faces the stylesheet names, under static/fonts. */
const FONT = /^\/fonts\/[a-z0-9-]+\.woff2$/;

/** A posted form is small; anything bigger is not one. */
const MAX_BODY = 4096;

const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

class TooLarge extends Error {}

/**
 * The web UI: three pages rendered from the database and the log on every request, plus the
 * stylesheets (the drafting sheet shared with pipeline-ui, and the UI's own), their fonts and the
 * scripts. Pages, styles and scripts are not cached: an edit shows on reload; the fonts are. The
 * one write is `POST /requests`: a check asked for by hand, which the service serves. `/healthz`
 * answers a monitor: 200 while the service runs and polls, 503 otherwise.
 *
 * A page is served only to a Host the UI knows (an IP address, localhost, this machine's name,
 * UI_HOSTNAMES): a site that points its own name at this server cannot read the pages through a
 * visitor's browser. A request is taken only from the UI's own pages: another site cannot make a
 * visitor's browser ask for checks. With UI_USER and UI_PASSWORD, every page asks for the login.
 */
export function startUi(config: UiConfig, host = config.host, port = config.port): Promise<Server> {
  // One reader lives for the server's life: it reads the log incrementally.
  const serviceLog = new ServiceLog(config.logFile);
  const server = createServer((req, res) => {
    handle(req, res, config, serviceLog).catch((err: unknown) => {
      if (err instanceof TooLarge) {
        // Answer, then drop the connection: the rest of the body is never read.
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
        send(res, 413, 'text/plain', 'Request body too large.');
        return;
      }
      log.error('ui_error', { url: req.url, error: describeError(err) });
      const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: null, now: new Date() };
      if (!res.headersSent) send(res, 500, 'text/html', errorPage(500, describeError(err), ctx));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: UiConfig, serviceLog: ServiceLog): Promise<void> {
  if (!knownHost(req.headers.host, config)) return send(res, 421, 'text/plain', 'Unknown host name: open the UI by its address.');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path === '/healthz') {
    const h = health(serviceLog.read(), new Date());
    return send(res, h.ok ? 200 : 503, 'application/json', JSON.stringify(h));
  }
  if (config.login && !loggedIn(req.headers.authorization, config.login)) {
    res.writeHead(401, { ...HEADERS, 'WWW-Authenticate': 'Basic realm="Bug validator", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Login required.');
    return;
  }
  const type = STATIC[path] ?? (FONT.test(path) ? 'font/woff2' : undefined);
  if (type) {
    const file = new URL(`./static${path}`, import.meta.url);
    // A font never changes under its name; everything else may be edited and must show on reload.
    if (existsSync(file)) send(res, 200, type, readFileSync(file), type === 'font/woff2' ? 'public, max-age=31536000, immutable' : 'no-store');
    else send(res, 404, 'text/plain', `No file at ${path}.`);
    return;
  }
  const status = serviceLog.read();
  const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: status?.dryRun ?? null, now: new Date(), host: req.headers.host };
  if (req.method === 'POST' && path === '/requests') {
    if (!sameOrigin(req)) return send(res, 403, 'text/html', errorPage(403, 'A check can be asked for from the UI’s own pages only.', ctx));
    const form = new URLSearchParams(await body(req));
    try {
      const key = requestCheck(config.dbFile, form.get('key') ?? '');
      res.writeHead(303, { ...HEADERS, Location: `/bugs/${key}` });
      res.end();
    } catch (err) {
      send(res, 400, 'text/html', errorPage(400, err instanceof Error ? err.message : String(err), ctx));
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
  if (path === '/') {
    send(res, 200, 'text/html', homePage({ bugs: readBugs(config.dbFile), status, logPath: config.logFile, recent: serviceLog.recent, requests: readRequests(config.dbFile) }, ctx));
  } else if (path === '/bugs') {
    send(res, 200, 'text/html', bugsPage(readBugs(config.dbFile), bugsQuery(url.searchParams), ctx));
  } else if (path.startsWith('/bugs/')) {
    const key = path.slice('/bugs/'.length);
    if (!ISSUE_KEY.test(key)) return send(res, 400, 'text/html', errorPage(400, `Not a KAZ or RPG key: ${key}`, ctx));
    const bug = readBug(config.dbFile, key);
    const request = readRequests(config.dbFile).find((r) => r.key === key) ?? null;
    if (!bug && !request) send(res, 404, 'text/html', errorPage(404, `${key} is not in the database.`, ctx));
    else send(res, 200, 'text/html', bugPage({ key, bug, request }, ctx));
  } else {
    send(res, 404, 'text/html', errorPage(404, `No page at ${path}.`, ctx));
  }
}

/** The Host header names this server: an IP address, localhost, this machine's name or one of UI_HOSTNAMES. */
export function knownHost(header: string | undefined, config: Pick<UiConfig, 'hostnames'>): boolean {
  if (!header) return false;
  const name = (/^\[([^\]]+)\](?::\d+)?$/.exec(header)?.[1] ?? header.replace(/:\d+$/, '')).toLowerCase();
  return isIP(name) !== 0 || name === 'localhost' || name === hostname().toLowerCase() || config.hostnames.includes(name);
}

/** The form was sent by one of the UI's own pages. A browser says where a request comes from; curl says nothing and is let through. */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function loggedIn(header: string | undefined, login: { user: string; password: string }): boolean {
  const given = Buffer.from(/^Basic (.+)$/i.exec(header ?? '')?.[1] ?? '', 'base64');
  const wanted = Buffer.from(`${login.user}:${login.password}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_BODY) {
        req.removeAllListeners('data');
        req.pause();
        reject(new TooLarge());
      }
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache = 'no-store'): void {
  res.writeHead(status, {
    ...HEADERS,
    'Content-Type': type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type,
    'Cache-Control': cache,
  });
  res.end(body);
}
