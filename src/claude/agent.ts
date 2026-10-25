import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';

/**
 * The agent did not deliver a verdict. `start`: claude could not be started at all — about the
 * machine, not the bug, so it must not count against the bug. `run`: this run failed (timeout,
 * non-zero exit, output that is not a verdict).
 */
export class AgentError extends Error {
  readonly kind: 'start' | 'run';

  constructor(message: string, kind: 'start' | 'run' = 'run') {
    super(message);
    this.name = 'AgentError';
    this.kind = kind;
  }
}

export interface AgentRun {
  output: unknown;
  costUsd: number;
  durationMs: number;
  turns: number;
}

export interface Agent {
  run(prompt: string, jsonSchema: object, signal?: AbortSignal): Promise<AgentRun>;
}

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

const INSTRUCTIONS = new URL('../../agent/instructions.md', import.meta.url);
const JIRA_MCP = fileURLToPath(new URL('./jira-mcp.ts', import.meta.url));
const JIRA_TOOLS = ['mcp__jira__search_issues', 'mcp__jira__get_issue'];
/** Enough for a few searches and reads; a run that needs more is lost anyway. */
const MAX_TURNS = 25;

/** What `claude -p --output-format json` printed → the run, or an AgentError saying why not. */
export function parseClaudeResult(stdout: string): AgentRun {
  let result: ClaudeResult;
  try {
    result = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new AgentError(`claude printed something other than JSON: ${stdout.slice(0, 200)}`);
  }
  if (result.is_error) throw new AgentError(`claude reported an error: ${result.result ?? '(no message)'}`);
  if (result.structured_output === undefined) throw new AgentError(`claude returned no structured output: ${(result.result ?? '').slice(0, 200)}`);
  return {
    output: result.structured_output,
    costUsd: result.total_cost_usd ?? 0,
    durationMs: result.duration_ms ?? 0,
    turns: result.num_turns ?? 0,
  };
}

/**
 * Claude Code headless (`claude -p`). No built-in tools, no settings, no CLAUDE.md: it runs in a
 * temp directory with one MCP server, the project's read-only Jira search and read. The bug comes
 * in the prompt, the verdict comes back as structured output.
 */
export class ClaudeAgent implements Agent {
  private readonly opts: Config['agent'];
  private readonly cwd = join(tmpdir(), 'bug-validator-agent');

  constructor(opts: Config['agent']) {
    this.opts = opts;
    mkdirSync(this.cwd, { recursive: true });
  }

  /** The installed claude's version; throws when it cannot be started — fail at start, not per bug. */
  static version(): string {
    const probe = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.error) throw new AgentError(`cannot start claude: ${probe.error.message}`, 'start');
    if (probe.status !== 0) throw new AgentError(`claude --version exited with ${probe.status}: ${probe.stderr.trim().slice(0, 300)}`, 'start');
    return probe.stdout.trim();
  }

  async run(prompt: string, jsonSchema: object, signal?: AbortSignal): Promise<AgentRun> {
    // Read on every run, so an edit to the instructions reaches the next bug without a restart.
    const instructions = await readFile(INSTRUCTIONS, 'utf8');
    const { JIRA_BASE_URL, JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    const mcpConfig = {
      mcpServers: { jira: { command: process.execPath, args: [JIRA_MCP], env: { JIRA_BASE_URL, JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN } } },
    };
    const args = [
      '-p',
      '--model', this.opts.model,
      '--tools', '',
      '--mcp-config', JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      '--allowedTools', JIRA_TOOLS.join(','),
      '--setting-sources', '',
      '--no-session-persistence',
      '--max-turns', String(MAX_TURNS),
      '--output-format', 'json',
      '--json-schema', JSON.stringify(jsonSchema),
      '--system-prompt', instructions,
    ];
    return parseClaudeResult(await this.exec(args, prompt, signal));
  }

  private exec(args: string[], stdin: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let killedBy: string | undefined;
      const kill = (reason: string): void => {
        killedBy = reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill(`timed out after ${this.opts.timeoutMs / 1000}s`), this.opts.timeoutMs);
      const onAbort = (): void => kill('the service is stopping');
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      // claude may exit (a bad flag, no auth) before reading the prompt; `close` reports why.
      child.stdin.on('error', () => undefined);
      child.on('error', (e: NodeJS.ErrnoException) => {
        done();
        reject(new AgentError(`cannot start claude: ${e.message}`, e.code === 'ENOENT' ? 'start' : 'run'));
      });
      child.on('close', (code) => {
        done();
        if (killedBy) reject(new AgentError(killedBy));
        else if (code !== 0) reject(new AgentError(`claude exited with ${code}: ${err.trim().slice(0, 300)}`));
        else resolve(out);
      });
      child.stdin.end(stdin);
    });
  }
}
