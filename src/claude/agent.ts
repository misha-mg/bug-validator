import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';

/**
 * The agent did not deliver a verdict. Of the kinds, only `run` is about this bug: the run failed
 * (timeout, a bad exit, output that is not a verdict). The others must not count against it:
 * `start`, claude could not be started; `service`, the Claude service or the agent's Jira failed
 * (auth, a usage or rate limit, overload, a 5xx); `stopped`, the service is stopping.
 */
export class AgentError extends Error {
  readonly kind: 'start' | 'service' | 'stopped' | 'run';

  constructor(message: string, kind: AgentError['kind'] = 'run') {
    super(message);
    this.name = 'AgentError';
    this.kind = kind;
  }

  get environmental(): boolean {
    return this.kind !== 'run';
  }
}

export interface AgentRun {
  output: unknown;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** The model and a hash of agent/instructions.md the run used: which prompt wrote which comment. */
  model?: string;
  instructions?: string;
}

export interface Agent {
  run(prompt: string, jsonSchema: object, signal?: AbortSignal): Promise<AgentRun>;
}

interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
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
/** The variable that tells the Jira tool where to note Jira's failures (jira-mcp.ts). */
export const TOOL_ERRORS_ENV = 'BUG_VALIDATOR_TOOL_ERRORS';

// What claude says when the trouble is the Claude service, not the run: auth, limits, overload,
// the API or the network. A prompt too long for the model is the bug's.
const SERVICE_TROUBLE = /rate.?limit|usage limit|limit reached|overloaded|\b5\d\d\b|api error|authenticat|unauthori[sz]ed|invalid api key|oauth|token.{0,20}expired|\/login|credit balance|quota|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i;
const RUN_TROUBLE = /prompt is too long|max.?tokens|max.?turns|budget/i;

/** Which kind of failure claude's message describes. */
export function troubleKind(message: string): 'service' | 'run' {
  return SERVICE_TROUBLE.test(message) && !RUN_TROUBLE.test(message) ? 'service' : 'run';
}

/** What `claude -p --output-format json` printed → the run, or an AgentError saying why not. */
export function parseClaudeResult(stdout: string): AgentRun {
  let result: ClaudeResult;
  try {
    result = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new AgentError(`claude printed something other than JSON: ${stdout.slice(0, 200)}`);
  }
  if (result.is_error) {
    const message = `claude reported an error${result.subtype ? ` (${result.subtype})` : ''}: ${result.result ?? '(no message)'}`;
    throw new AgentError(message, troubleKind(message));
  }
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
 * private temp directory with one MCP server, the project's read-only Jira search and read. The
 * server's config, Jira credentials included, is a file only this user can read, never a
 * command-line argument (which every user on the machine can see). The bug comes in the prompt,
 * the verdict comes back as structured output.
 */
export class ClaudeAgent implements Agent {
  private readonly opts: Config['agent'];
  private readonly dir: string;

  constructor(opts: Config['agent']) {
    this.opts = opts;
    // mkdtemp makes it 0700 and unique: no other user can read it or create it first.
    this.dir = mkdtempSync(join(tmpdir(), 'bug-validator-'));
    process.once('exit', () => rmSync(this.dir, { recursive: true, force: true }));
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
    const runDir = mkdtempSync(join(this.dir, 'run-'));
    try {
      const toolErrors = join(runDir, 'tool-errors');
      const { JIRA_BASE_URL, JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
      const mcpConfig = join(runDir, 'mcp.json');
      const env = { JIRA_BASE_URL, JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN, [TOOL_ERRORS_ENV]: toolErrors };
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { jira: { command: process.execPath, args: [JIRA_MCP], env } } }), { mode: 0o600 });
      const args = [
        '-p',
        '--model', this.opts.model,
        '--tools', '',
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--allowedTools', JIRA_TOOLS.join(','),
        '--setting-sources', '',
        '--no-session-persistence',
        '--max-turns', String(MAX_TURNS),
        '--max-budget-usd', String(this.opts.maxBudgetUsd),
        '--output-format', 'json',
        '--json-schema', JSON.stringify(jsonSchema),
        '--system-prompt', instructions,
      ];
      const run = parseClaudeResult(await this.exec(args, prompt, runDir, signal));
      // A search that failed on Jira's side reads to the agent as "nothing found": a related bug
      // missed for no reason of the bug's. The run is not trusted.
      const failed = readIfAny(toolErrors);
      if (failed) throw new AgentError(`Jira failed for the agent: ${failed.trim().split('\n')[0]?.slice(0, 300)}`, 'service');
      return { ...run, model: this.opts.model, instructions: createHash('sha256').update(instructions).digest('hex').slice(0, 12) };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  private exec(args: string[], stdin: string, cwd: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new AgentError('the service is stopping', 'stopped'));
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let killedBy: AgentError | undefined;
      const kill = (reason: AgentError): void => {
        killedBy = reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill(new AgentError(`timed out after ${this.opts.timeoutMs / 1000}s`)), this.opts.timeoutMs);
      const onAbort = (): void => kill(new AgentError('the service is stopping', 'stopped'));
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
        if (killedBy) return reject(killedBy);
        if (code === 0) return resolve(out);
        // claude prints its JSON result on stdout even when it exits badly; that says more than stderr.
        try {
          parseClaudeResult(out);
        } catch (e) {
          if (e instanceof AgentError && out.trim().startsWith('{')) return reject(e);
        }
        const message = `claude exited with ${code}: ${(err.trim() || out.trim()).slice(0, 300)}`;
        reject(new AgentError(message, troubleKind(message)));
      });
      child.stdin.end(stdin);
    });
  }
}

function readIfAny(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
