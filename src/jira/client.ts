import type { Config } from '../config.ts';

/**
 * A Jira request failed. Without a status it never reached Jira (network, timeout); with one, Jira
 * answered. `environmental` says whether the failure is about the service's surroundings rather
 * than about one bug: those failures must not count against a bug's attempts.
 */
export class JiraError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }

  get environmental(): boolean {
    return this.status === undefined || this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500;
  }
}

export interface RawIssue {
  /** Stays the same when the issue moves to another project; the key does not. */
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

interface SearchPage {
  issues: RawIssue[];
  isLast: boolean;
  nextPageToken?: string;
}

/** One change to an issue: who, when, and the fields it touched. */
export interface ChangelogEntry {
  author: { accountId: string } | null;
  created: string;
  items: { field: string; fieldId?: string; fromString: string | null; toString: string | null }[];
}

/** What the pipeline needs from Jira; `JiraClient` is the real thing, tests use a fake. */
export interface Jira {
  search(jql: string, fields: string[], maxResults: number): Promise<RawIssue[]>;
  getIssue(key: string): Promise<RawIssue>;
  addComment(key: string, body: string): Promise<{ id: string }>;
}

export const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'project', 'labels', 'versions', 'customfield_10033',
  'attachment', 'reporter', 'comment', 'created', 'updated',
];

const REQUEST_TIMEOUT_MS = 30_000;

/** Jira REST v2 through the api.atlassian.com gateway (scoped API tokens work only there). */
export class JiraClient implements Jira {
  private readonly api: string;
  private readonly auth: string;

  constructor(jira: Config['jira']) {
    this.api = `https://api.atlassian.com/ex/jira/${jira.cloudId}/rest/api/2`;
    this.auth = 'Basic ' + Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
  }

  async search(jql: string, fields: string[], maxResults: number): Promise<RawIssue[]> {
    const issues: RawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const params = new URLSearchParams({ jql, fields: fields.join(','), maxResults: String(maxResults) });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const page = await this.request<SearchPage>(`/search/jql?${params}`);
      issues.push(...page.issues);
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken && issues.length < maxResults);
    return issues.slice(0, maxResults);
  }

  getIssue(key: string): Promise<RawIssue> {
    return this.request<RawIssue>(`/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`);
  }

  /** Every change to the issue, oldest first. Used by `scripts/`, not by the service. */
  async changelog(key: string): Promise<ChangelogEntry[]> {
    const entries: ChangelogEntry[] = [];
    for (;;) {
      const page = await this.request<{ values: ChangelogEntry[]; isLast: boolean }>(
        `/issue/${encodeURIComponent(key)}/changelog?startAt=${entries.length}&maxResults=100`,
      );
      entries.push(...page.values);
      if (page.isLast || page.values.length === 0) return entries;
    }
  }

  /** The program's only write to Jira. */
  addComment(key: string, body: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.api + path, {
        ...init,
        headers: { Authorization: this.auth, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // fetch says only "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, timeout) is the cause.
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
      throw new JiraError(`request failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new JiraError(`HTTP ${res.status} on ${init.method ?? 'GET'} ${path}: ${text}`, res.status);
    }
    return (await res.json()) as T;
  }
}
