// Jira REST v2 through api.atlassian.com: search, issues, attachments, myself, changelog; add and edit comment, the only writes.
import type { JiraConfig } from '../config.ts'

/**
 * A Jira request failed. Without a status it never reached Jira (network, timeout); with one, Jira
 * answered. `environmental` says whether the failure is about the service's surroundings rather
 * than about one bug: those failures must not count against a bug's attempts.
 */
export class JiraError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'JiraError'
    this.status = status
  }

  get environmental(): boolean {
    return this.status === undefined || this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500
  }

  /** Jira answered with an error, so a write it was asked for was not made. Without a status nobody knows. */
  get refused(): boolean {
    return this.status !== undefined
  }
}

export interface RawIssue {
  /** Stays the same when the issue moves to another project; the key does not. */
  id: string
  key: string
  fields: Record<string, unknown>
}

interface SearchPage {
  issues: RawIssue[]
  isLast: boolean
  nextPageToken?: string
}

/** One change to an issue: who, when, and the fields it touched. */
export interface ChangelogEntry {
  author: { accountId: string } | null
  created: string
  items: { field: string; fieldId?: string; fromString: string | null; toString: string | null }[]
}

/** What the pipeline needs from Jira; `JiraClient` is the real thing, tests use a fake. */
export interface Jira {
  search(jql: string, fields: string[], maxResults: number): Promise<RawIssue[]>
  getIssue(key: string): Promise<RawIssue>
  /** An attachment's bytes, by its id. */
  attachment(id: string): Promise<ReadableStream<Uint8Array>>
  /** The account the service writes as: its comments are found among a bug's by this id. */
  myself(): Promise<{ accountId: string }>
  addComment(key: string, body: string): Promise<{ id: string }>
  editComment(key: string, commentId: string, body: string): Promise<void>
}

export const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'project',
  'labels',
  'versions',
  'customfield_10033',
  'attachment',
  'reporter',
  'comment',
  'created',
  'updated',
]

/** What the poll reads of every bug in the query: the report (domain/fingerprint.ts) and its times. */
export const REPORT_FIELDS = [
  'summary',
  'description',
  'status',
  'project',
  'versions',
  'customfield_10033',
  'attachment',
  'reporter',
  'comment',
  'created',
  'updated',
]

const REQUEST_TIMEOUT_MS = 30_000
/** A download of up to 50 MB (pipeline/attachments.ts) over an office line. */
const DOWNLOAD_TIMEOUT_MS = 180_000

/**
 * Jira REST v2 through the api.atlassian.com gateway (scoped API tokens work only there), by the
 * site's cloud id: JIRA_CLOUD_ID when set, otherwise read once from the site's /_edge/tenant_info.
 */
export class JiraClient implements Jira {
  private readonly site: string
  private readonly cloudId: string | null
  private readonly auth: string
  private api: Promise<string> | undefined
  private self: Promise<{ accountId: string }> | undefined

  constructor(jira: JiraConfig) {
    this.site = jira.baseUrl
    this.cloudId = jira.cloudId
    this.auth = 'Basic ' + Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64')
  }

  /** The REST base, asked for once; a lookup that failed is asked again next time. */
  private apiBase(): Promise<string> {
    this.api ??= this.lookupCloudId().then(
      (id) => `https://api.atlassian.com/ex/jira/${id}/rest/api/2`,
      (err: unknown) => {
        this.api = undefined
        throw err
      },
    )
    return this.api
  }

  /** The site says its own cloud id, to anyone; a failure here is the surroundings', never a bug's. */
  private async lookupCloudId(): Promise<string> {
    if (this.cloudId) return this.cloudId
    const url = `${this.site}/_edge/tenant_info`
    let info: { cloudId?: unknown }
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) throw new JiraError(`HTTP ${res.status} on GET ${url}: the site's tenant info`)
      info = (await res.json()) as { cloudId?: unknown }
    } catch (err) {
      if (err instanceof JiraError) throw err
      throw new JiraError(`request failed: ${describe(err)} (GET ${url})`)
    }
    if (typeof info.cloudId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(info.cloudId))
      throw new JiraError(`no cloud id in ${url}: set JIRA_CLOUD_ID`)
    return info.cloudId
  }

  async search(jql: string, fields: string[], maxResults: number): Promise<RawIssue[]> {
    const issues: RawIssue[] = []
    let nextPageToken: string | undefined
    do {
      const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(maxResults) })
      if (nextPageToken) params.set('nextPageToken', nextPageToken)
      const page = await this.request<SearchPage>(`/search/jql?${params}`)
      issues.push(...page.issues)
      nextPageToken = page.isLast ? undefined : page.nextPageToken
    } while (nextPageToken && issues.length < maxResults)
    return issues.slice(0, maxResults)
  }

  getIssue(key: string): Promise<RawIssue> {
    return this.request<RawIssue>(`/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`)
  }

  /**
   * Jira answers with a redirect to a signed media URL, which fetch follows; the Authorization
   * header does not go along to the other origin, and the signed URL needs none. Read as a stream;
   * the caller checks Jira's declared size before asking.
   */
  async attachment(id: string): Promise<ReadableStream<Uint8Array>> {
    const path = `/attachment/content/${encodeURIComponent(id)}`
    let res: Response
    try {
      res = await fetch((await this.apiBase()) + path, {
        headers: { Authorization: this.auth },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
    } catch (err) {
      throw new JiraError(`request failed: ${describe(err)}`)
    }
    if (!res.ok) throw new JiraError(`HTTP ${res.status} on GET ${path}: ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status)
    return res.body ?? new ReadableStream({ start: (c) => c.close() })
  }

  /** Asked once; a failed ask is asked again next time. */
  myself(): Promise<{ accountId: string }> {
    this.self ??= this.request<{ accountId: string }>('/myself').catch((err: unknown) => {
      this.self = undefined
      throw err
    })
    return this.self
  }

  /** Every change to the issue, oldest first. Used by `scripts/`, not by the service. */
  async changelog(key: string): Promise<ChangelogEntry[]> {
    const entries: ChangelogEntry[] = []
    for (;;) {
      const page = await this.request<{ values: ChangelogEntry[]; isLast: boolean }>(
        `/issue/${encodeURIComponent(key)}/changelog?startAt=${entries.length}&maxResults=100`,
      )
      entries.push(...page.values)
      if (page.isLast || page.values.length === 0) return entries
    }
  }

  /** One of the program's two writes to Jira: a new comment. */
  addComment(key: string, body: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  }

  /** The other write: the service's own comment, edited after a re-check. */
  async editComment(key: string, commentId: string, body: string): Promise<void> {
    await this.request<unknown>(`/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ body }),
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    let body: string
    // The body is read inside the try as well: a timeout or a reset while it arrives is a request
    // that failed without an answer, like one that never reached Jira.
    try {
      res = await fetch((await this.apiBase()) + path, {
        ...init,
        headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      body = await res.text()
    } catch (err) {
      throw new JiraError(`request failed: ${describe(err)}`)
    }
    if (!res.ok) throw new JiraError(`HTTP ${res.status} on ${init.method ?? 'GET'} ${path}: ${body.slice(0, 300)}`, res.status)
    try {
      return (body ? JSON.parse(body) : null) as T
    } catch {
      throw new JiraError(`HTTP ${res.status} on ${init.method ?? 'GET'} ${path}: not JSON: ${body.slice(0, 200)}`)
    }
  }
}

/** fetch says only "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, timeout) is the cause. */
function describe(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  return `${err instanceof Error ? err.message : String(err)}${cause}`
}
