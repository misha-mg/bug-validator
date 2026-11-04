// The agent's Jira tool: read-only search and issue read, served over MCP (streamable HTTP) by the
// service itself on loopback, so the Jira token never enters the sandbox. Hand-written JSON-RPC
// (initialize, tools/list, tools/call), so the project keeps one dependency. Each agent run gets
// a secret of its own, revoked when the run ends.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { ISSUE_KEY } from '../domain/key.ts';
import { type Jira, JiraError } from '../jira/client.ts';
import { toBug } from '../jira/mapping.ts';
import { scopedJql } from '../jira/queries.ts';

export const JIRA_TOOLS = ['mcp__jira__search_issues', 'mcp__jira__get_issue'];

const SearchInput = z.object({ jql: z.string().min(1), maxResults: z.number().int().min(1).max(20).default(10) });
const IssueInput = z.object({ key: z.string().regex(ISSUE_KEY) });

const TOOLS = [
  {
    name: 'search_issues',
    description:
      'Search Jira with JQL. Returns key, summary, status, resolution and updated for up to maxResults issues in KAZ and RPG. ' +
      'Projects: KAZ (Kazaar, NPB hardware) and RPG (Arpeggio, AFS). Text search: summary ~ "word" or text ~ "word".',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL, e.g. project IN (KAZ, RPG) AND type = Bug AND summary ~ "scroll" ORDER BY updated DESC' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
      required: ['jql'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one KAZ or RPG issue: summary, status, labels, versions, devices, attachment names, description and comments.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Issue key, e.g. KAZ-8871' } },
      required: ['key'],
    },
  },
];

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const MAX_BODY = 64 * 1024;

export class JiraTool {
  private readonly jira: Pick<Jira, 'search' | 'getIssue'>;
  private readonly server: Server;
  /** The runs allowed in, by secret, with the first failure of Jira's own during each. */
  private readonly runs = new Map<string, { failure: string | null }>();

  constructor(jira: Pick<Jira, 'search' | 'getIssue'>) {
    this.jira = jira;
    this.server = createServer((req, res) => {
      // A body cut short (the run killed mid-request) or a surprise must not become an unhandled
      // rejection that ends the service.
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) end(res, 500, err instanceof Error ? err.message.slice(0, 200) : 'error');
        else res.destroy();
      });
    });
  }

  /** Listens on loopback at a port of its own. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
  }

  get url(): string {
    const address = this.server.address() as AddressInfo | null;
    if (!address) throw new Error('the Jira tool is not listening');
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  /** A secret for one run; the run's requests carry it as a bearer token. */
  grant(): string {
    const secret = randomBytes(24).toString('base64url');
    this.runs.set(secret, { failure: null });
    return secret;
  }

  /** Jira's own failure during the run, if any: a search that failed is not "nothing found". */
  failure(secret: string): string | null {
    return this.runs.get(secret)?.failure ?? null;
  }

  revoke(secret: string): void {
    this.runs.delete(secret);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const run = secret ? this.runs.get(secret) : undefined;
    if (!run) return end(res, 401, 'no such run');
    if (req.method === 'DELETE') return end(res, 200, '');
    if (req.method !== 'POST') return end(res, 405, 'POST only');
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req as AsyncIterable<string>) {
      body += chunk;
      if (body.length > MAX_BODY) return end(res, 413, 'too large');
    }
    let message: Request;
    try {
      message = JSON.parse(body) as Request;
    } catch {
      return end(res, 400, 'not JSON');
    }
    if (typeof message !== 'object' || message === null || typeof message.method !== 'string') return end(res, 400, 'not a request');
    if (message.id === undefined) return end(res, 202, ''); // a notification (notifications/initialized) needs no answer
    const answer = await this.answer(message, run);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  }

  private async answer(req: Request, run: { failure: string | null }): Promise<object> {
    const { id, method, params = {} } = req;
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: params['protocolVersion'] ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jira', version: '0.2.0' } } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = String(params['name']);
        try {
          const text = await this.call(name, params['arguments'] ?? {});
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A bad JQL is the agent's to fix; Jira itself failing makes the run untrustworthy (agent.ts).
          if (err instanceof JiraError && err.environmental) run.failure ??= `${name}: ${message}`;
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${message}` }], isError: true } };
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }

  private async call(name: string, args: unknown): Promise<string> {
    if (name === 'search_issues') {
      const { jql, maxResults } = SearchInput.parse(args);
      const issues = await this.jira.search(scopedJql(jql), ['summary', 'status', 'resolution', 'updated'], maxResults);
      return JSON.stringify(
        issues
          // The personal account sees every project; the agent sees only the two in scope.
          .filter((i) => ISSUE_KEY.test(i.key))
          .map((i) => {
            const f = i.fields as { summary?: string; status?: { name: string }; resolution?: { name: string } | null; updated?: string };
            return { key: i.key, summary: f.summary, status: f.status?.name, resolution: f.resolution?.name ?? null, updated: f.updated?.slice(0, 10) };
          }),
      );
    }
    if (name === 'get_issue') {
      const { key } = IssueInput.parse(args);
      const b = toBug(await this.jira.getIssue(key));
      return JSON.stringify({
        key: b.key, summary: b.summary, status: b.status, labels: b.labels, versions: b.versions, devices: b.devices,
        attachments: b.attachments.map((a) => a.filename), created: b.created.slice(0, 10), updated: b.updated.slice(0, 10),
        description: b.description.slice(0, 4000),
        comments: b.comments.map((c) => ({ author: c.author, created: c.created.slice(0, 10), body: c.body.slice(0, 1500) })),
      });
    }
    throw new Error(`unknown tool ${name}`);
  }
}

function end(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}
