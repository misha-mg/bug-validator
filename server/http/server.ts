// The console's HTTP server (node:http): the pages, the static files under ui/, /healthz; guard.ts on every request.
import { existsSync, readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { requestCheck, requestPost } from '../store/store.ts'
import { ISSUE_KEY } from '../domain/key.ts'
import { describeError, log } from '../log.ts'
import type { UiConfig } from './config.ts'
import { SECURITY_HEADERS, TooLarge, knownHost, loggedIn, loginChallenge, readBody, sameOrigin } from './guard.ts'
import { type PageContext, bugPage, bugsPage, bugsQuery, errorPage, homePage, statsPage, toastOf, toastParam } from './view.ts'
import { readBug, readBugs, readHeartbeat, readPosts, readRequests } from './read.ts'
import { health, ServiceLog } from './service-log.ts'
import { periodOf } from './stats.ts'

const STATIC: Record<string, string> = {
  '/sheet.css': 'text/css',
  '/app.css': 'text/css',
  '/app.js': 'text/javascript',
  '/theme.js': 'text/javascript',
  '/logo.svg': 'image/svg+xml',
}
/** The faces the stylesheet names (Inter, JetBrains Mono), under static/fonts. */
const FONT = /^\/fonts\/[a-z0-9-]+\.woff2$/

/** A posted form is small; anything bigger is not one. */
const MAX_BODY = 4096

/**
 * Where a POST sends the browser: the page its form was on (the Referer, when it is a page of
 * this UI), without the one-off parameters that page may carry (an old toast, the post
 * confirmation); the Cockpit when there is none. A check asked for from the Bugs list or the
 * masthead leaves the person where they were.
 */
export function backTo(req: Pick<IncomingMessage, 'headers'>): string {
  const referer = req.headers.referer
  if (!referer) return '/'
  let url: URL
  try {
    url = new URL(referer)
  } catch {
    return '/'
  }
  if (url.host !== req.headers.host) return '/'
  url.searchParams.delete('toast')
  url.searchParams.delete('post')
  return url.pathname + url.search
}

/** What a person can ask the service for: the form's path → the request it writes; returns the bug's key and what the toast says. */
const ACTIONS: Record<string, (dbFile: string, form: URLSearchParams) => { key: string; done: string }> = {
  '/requests': (dbFile, form) => {
    const key = requestCheck(dbFile, form.get('key') ?? '')
    return { key, done: `Check of ${key} requested: the service takes it before its next poll` }
  },
  '/posts': (dbFile, form) => {
    const key = requestPost(dbFile, form.get('key') ?? '', form.get('checked') ?? '')
    return { key, done: `Post of the comment on ${key} requested: the service posts it next` }
  },
}

/**
 * The web UI: the pages rendered from the database and the log on every request, plus the
 * stylesheets (the sheet shared with pipeline-ui, and the UI's own), their fonts and the
 * scripts. Pages, styles and scripts are not cached: an edit shows on reload; the fonts are. The
 * writes are `POST /requests`, a check asked for by hand, and `POST /posts`, a recorded comment
 * to post to Jira: rows the service serves. `/healthz`
 * answers a monitor: 200 while the service runs and polls, 503 otherwise.
 *
 * A page is served only to a Host the UI knows (an IP address, localhost, this machine's name,
 * VALIDATOR_HOSTNAMES): a site that points its own name at this server cannot read the pages through a
 * visitor's browser. A request is taken only from the UI's own pages: another site cannot make a
 * visitor's browser ask for checks. With VALIDATOR_USER and VALIDATOR_PASSWORD, every page asks for the login.
 */
export function startUi(config: UiConfig, host = config.host, port = config.port): Promise<Server> {
  // One reader lives for the server's life: it reads the log incrementally.
  const serviceLog = new ServiceLog(config.logFile)
  const server = createServer((req, res) => {
    handle(req, res, config, serviceLog).catch((err: unknown) => {
      if (err instanceof TooLarge) {
        // Answer, then drop the connection: the rest of the body is never read.
        res.setHeader('Connection', 'close')
        res.on('finish', () => req.destroy())
        send(res, 413, 'text/plain', 'Request body too large.')
        return
      }
      log.error('ui_error', { url: req.url, error: describeError(err) })
      const ctx: PageContext = { jiraBaseUrl: config.jiraBaseUrl, dryRun: null, now: new Date() }
      if (!res.headersSent) send(res, 500, 'text/html', errorPage(500, describeError(err), ctx))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, config: UiConfig, serviceLog: ServiceLog): Promise<void> {
  if (!knownHost(req.headers.host, config.guard)) return send(res, 421, 'text/plain', 'Unknown host name: open the UI by its address.')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path === '/healthz') {
    const h = health(serviceLog.read(), new Date(), readHeartbeat(config.dbFile))
    return send(res, h.ok ? 200 : 503, 'application/json', JSON.stringify(h))
  }
  if (config.guard.login && !loggedIn(req.headers.authorization, config.guard.login)) {
    res.writeHead(401, {
      ...SECURITY_HEADERS,
      ...loginChallenge(config.guard),
      'Content-Type': 'text/plain; charset=utf-8',
    })
    res.end('Login required.')
    return
  }
  const type = STATIC[path] ?? (FONT.test(path) ? 'font/woff2' : undefined)
  if (type) {
    const file = new URL(`../../ui${path}`, import.meta.url)
    // A font never changes under its name; everything else may be edited and must show on reload.
    if (existsSync(file))
      send(res, 200, type, readFileSync(file), type === 'font/woff2' ? 'public, max-age=31536000, immutable' : 'no-store')
    else send(res, 404, 'text/plain', `No file at ${path}.`)
    return
  }
  const status = serviceLog.read()
  const ctx: PageContext = {
    jiraBaseUrl: config.jiraBaseUrl,
    dryRun: status?.dryRun ?? null,
    now: new Date(),
    host: req.headers.host,
    toast: toastOf(url.searchParams),
  }
  const action = req.method === 'POST' ? ACTIONS[path] : undefined
  if (action) {
    if (!sameOrigin(req))
      return send(res, 403, 'text/html', errorPage(403, 'A check or a post can be asked for from the UI’s own pages only.', ctx))
    const form = new URLSearchParams(await readBody(req, MAX_BODY))
    try {
      const { done } = action(config.dbFile, form)
      // Back to the page the form was on, with the notification in the URL: app.js shows it as a
      // toast, a page without JavaScript as a notice.
      const back = new URL(backTo(req), 'http://x')
      back.searchParams.set('toast', toastParam({ kind: 'success', text: done }))
      res.writeHead(303, { ...SECURITY_HEADERS, Location: back.pathname + back.search })
      res.end()
    } catch (err) {
      send(res, 400, 'text/html', errorPage(400, err instanceof Error ? err.message : String(err), ctx))
    }
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only')
  if (path === '/') {
    send(
      res,
      200,
      'text/html',
      homePage(
        {
          bugs: readBugs(config.dbFile),
          status,
          logPath: config.logFile,
          recent: serviceLog.recent,
          requests: readRequests(config.dbFile),
          heartbeat: readHeartbeat(config.dbFile),
          dbPath: config.dbFile,
          dbFound: existsSync(config.dbFile),
        },
        ctx,
      ),
    )
  } else if (path === '/bugs') {
    send(res, 200, 'text/html', bugsPage(readBugs(config.dbFile), bugsQuery(url.searchParams), ctx))
  } else if (path === '/stats') {
    send(res, 200, 'text/html', statsPage(readBugs(config.dbFile), periodOf(url.searchParams.get('period')), ctx))
  } else if (path.startsWith('/bugs/')) {
    const key = path.slice('/bugs/'.length)
    if (!ISSUE_KEY.test(key)) return send(res, 400, 'text/html', errorPage(400, `Not a KAZ or RPG key: ${key}`, ctx))
    const bug = readBug(config.dbFile, key)
    const request = readRequests(config.dbFile).find((r) => r.key === key) ?? null
    const post = readPosts(config.dbFile).find((r) => r.key === key) ?? null
    if (!bug && !request) send(res, 404, 'text/html', errorPage(404, `${key} is not in the database.`, ctx))
    else send(res, 200, 'text/html', bugPage({ key, bug, request, post, confirmPost: url.searchParams.has('post') }, ctx))
  } else {
    send(res, 404, 'text/html', errorPage(404, `No page at ${path}.`, ctx))
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache = 'no-store'): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type,
    'Cache-Control': cache,
  })
  res.end(body)
}
