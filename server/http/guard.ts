// What the HTTP server of both consoles (pipeline-ui and bug-validator) checks before it serves
// anything, so that a console on the office network is not turned against its visitors: the
// headers every answer carries, the Host names it answers to, that a request that changes
// something comes from the console's own pages, an optional login, and a cap on a request's body.
// This file is the same in both repositories; each server decides which paths each check applies to.
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'

export type Login = { user: string; password: string }

export type Guard = {
  /** Names the console may be opened by besides IP addresses, localhost and this machine's name; lower case. */
  hostnames: string[]
  /** Both set: every page asks for this login (HTTP basic auth). */
  login: Login | null
  /** The realm the browser's login prompt names. */
  realm: string
}

/** The settings as the environment gives them: a comma-separated list of names, and a user and a password that go together. */
export function guardFromEnv(hostnames: string | undefined, user: string | undefined, password: string | undefined, realm: string): Guard {
  if (Boolean(user) !== Boolean(password)) throw new Error(`Bad configuration: the console's user and password go together`)
  return {
    hostnames: (hostnames ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    login: user && password ? { user, password } : null,
    realm,
  }
}

/** On every answer: the console's own scripts and styles only, never framed, forms only to itself. */
export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
} as const

/** The Host header names this server: an IP address, localhost, this machine's name or one of the names given. */
export function knownHost(header: string | undefined, guard: Pick<Guard, 'hostnames'>): boolean {
  if (!header) return false
  const name = (/^\[([^\]]+)\](?::\d+)?$/.exec(header)?.[1] ?? header.replace(/:\d+$/, '')).toLowerCase()
  return isIP(name) !== 0 || name === 'localhost' || name === hostname().toLowerCase() || guard.hostnames.includes(name)
}

/** The request was sent by one of the console's own pages. A browser says where a request comes from; curl says nothing and is let through. */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** The Authorization header carries the login, compared in constant time. */
export function loggedIn(header: string | undefined, login: Login): boolean {
  const given = Buffer.from(/^Basic (.+)$/i.exec(header ?? '')?.[1] ?? '', 'base64')
  const wanted = Buffer.from(`${login.user}:${login.password}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** The header that asks the browser for the login. */
export function loginChallenge(guard: Pick<Guard, 'realm'>): Record<string, string> {
  return { 'WWW-Authenticate': `Basic realm="${guard.realm}", charset="UTF-8"` }
}

export class TooLarge extends Error {
  constructor(limit: number) {
    super(`Request body over ${limit} bytes.`)
    this.name = 'TooLarge'
  }
}

/** The request's body as text, up to `limit` bytes; past it the promise rejects with TooLarge and the rest is never read. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      text += chunk
      if (text.length > limit) {
        req.removeAllListeners('data')
        req.pause()
        reject(new TooLarge(limit))
      }
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}
