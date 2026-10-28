// The agent's only tool: read-only Jira search and issue read, served over MCP on stdio.
// Hand-written JSON-RPC (initialize, tools/list, tools/call) so the project keeps one dependency.
// Started by claude itself (see agent.ts), which passes the JIRA_* variables in its environment.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { ISSUE_KEY } from '../domain/key.ts';
import { JiraError, JiraClient } from '../jira/client.ts';
import { toBug } from '../jira/mapping.ts';
import { scopedJql } from '../jira/queries.ts';
import { TOOL_ERRORS_ENV } from './agent.ts';

const jira = new JiraClient(loadConfig().jira);

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

async function callTool(name: string, args: unknown): Promise<string> {
  if (name === 'search_issues') {
    const { jql, maxResults } = SearchInput.parse(args);
    const issues = await jira.search(scopedJql(jql), ['summary', 'status', 'resolution', 'updated'], maxResults);
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
    const b = toBug(await jira.getIssue(key));
    return JSON.stringify({
      key: b.key, summary: b.summary, status: b.status, labels: b.labels, versions: b.versions, devices: b.devices,
      attachments: b.attachments.map((a) => a.filename), created: b.created.slice(0, 10), updated: b.updated.slice(0, 10),
      description: b.description.slice(0, 4000),
      comments: b.comments.map((c) => ({ author: c.author, created: c.created.slice(0, 10), body: c.body.slice(0, 1500) })),
    });
  }
  throw new Error(`unknown tool ${name}`);
}

interface Request { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req: Request): Promise<void> {
  const { id, method, params = {} } = req;
  if (id === undefined) return; // notifications (notifications/initialized) need no answer
  try {
    switch (method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id, result: { protocolVersion: params['protocolVersion'] ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jira', version: '0.1.0' } } });
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const name = String(params['name']);
        try {
          const text = await callTool(name, params['arguments'] ?? {});
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A bad JQL is the agent's to fix; Jira itself failing makes the run untrustworthy (agent.ts).
          const file = process.env[TOOL_ERRORS_ENV];
          if (file && err instanceof JiraError && err.environmental) appendFileSync(file, `${name}: ${message}\n`);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${message}` }], isError: true } });
        }
        return;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    return;
  }
  void handle(req);
});
