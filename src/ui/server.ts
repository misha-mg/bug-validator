import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { describeError, log } from '../log.ts';
import type { UiConfig } from './config.ts';
import { type PageContext, bugPage, bugsPage, bugsQuery, errorPage, homePage } from './html.ts';
import { readBug, readBugs } from './read.ts';
import { ServiceLog } from './service-log.ts';

const KEY = /^(KAZ|RPG)-\d+$/;
const STATIC: Record<string, string> = { '/app.css': 'text/css', '/app.js': 'text/javascript' };

/**
 * The web UI: three pages rendered from the database and the log on every request, plus a
 * stylesheet and the refresh script. Nothing is cached: an edit to a static file shows on reload,
 * and the pages are always what the files say now.
 */
export function startUi(config: UiConfig, host = config.host, port = config.port): Promise<Server> {
  // One reader lives for the server's life: it reads the log incrementally.
  const serviceLog = new ServiceLog(config.logFile);
  const server = createServer((req, res) => {
    try {
      handle(req, res, config, serviceLog);
    } catch (err) {
      log.error('ui_error', { url: req.url, error: describeError(err) });
      const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: null, now: new Date() };
      send(res, 500, 'text/html', errorPage(500, describeError(err), ctx));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function handle(req: IncomingMessage, res: ServerResponse, config: UiConfig, serviceLog: ServiceLog): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const type = STATIC[path];
  if (type) {
    send(res, 200, type, readFileSync(new URL(`./static${path}`, import.meta.url)));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain', 'GET only');
    return;
  }
  const status = serviceLog.read();
  const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: status?.dryRun ?? null, now: new Date() };
  if (path === '/') {
    send(res, 200, 'text/html', homePage({ bugs: readBugs(config.dbFile), status, logPath: config.logFile, recent: serviceLog.recent }, ctx));
  } else if (path === '/bugs') {
    send(res, 200, 'text/html', bugsPage(readBugs(config.dbFile), bugsQuery(url.searchParams), ctx));
  } else if (path.startsWith('/bugs/')) {
    const key = path.slice('/bugs/'.length);
    if (!KEY.test(key)) {
      send(res, 400, 'text/html', errorPage(400, `Not a KAZ or RPG key: ${key}`, ctx));
      return;
    }
    const bug = readBug(config.dbFile, key);
    if (!bug) send(res, 404, 'text/html', errorPage(404, `${key} is not in the database.`, ctx));
    else send(res, 200, 'text/html', bugPage(bug, ctx));
  } else {
    send(res, 404, 'text/html', errorPage(404, `No page at ${path}.`, ctx));
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(body);
}
