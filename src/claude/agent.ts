import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { JIRA_TOOLS, type JiraTool } from './jira-mcp.ts';
import { bwrapArgs, HOME, MCP_CONFIG, WORK_BUG } from './sandbox.ts';

/**
 * The agent did not deliver a verdict. Of the kinds, only `run` is about this bug: the run failed
 * (timeout, a bad exit, output that is not a verdict). The others must not count against it:
 * `start`, claude or bwrap could not be started; `service`, the Claude service or the agent's
 * Jira failed (auth, a usage or rate limit, overload, a 5xx); `stopped`, the service is stopping.
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
  /** What the agent could read in its sandbox and must not repeat: the run's tool secret, the Claude token. */
  secrets: string[];
}

export interface Agent {
  /** `bugDir` holds the run's files (pipeline/attachments.ts); the agent sees it as /work/bug. */
  run(prompt: string, jsonSchema: object, bugDir: string, signal?: AbortSignal): Promise<AgentRun>;
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
/** The built-in tools the agent may use: reading, nothing that runs, writes or fetches. */
const FILE_TOOLS = ['Read', 'Grep', 'Glob'];

// What claude says when the trouble is the Claude service, not the run: auth, limits, overload,
// the API or the network — in the forms its own messages take, since a message may quote the
// bug's text, and "network" or "/login" in a report must not spare the bug. A prompt too long
// for the model is the bug's.
const SERVICE_TROUBLE = /rate.?limit|usage limit|limit reached|overloaded|api error|(?:status|error)[: ]+5\d\d\b|\b5\d\d (?:internal|bad gateway|service unavailable|gateway)|authenticat|unauthori[sz]ed|invalid api key|oauth token|token.{0,20}(?:expired|invalid|revoked)|run \/login|credit balance|quota exceeded|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network error/i;
const RUN_TROUBLE = /prompt is too long|max.?tokens|max.?turns|budget/i;

/** Which kind of failure claude's message describes. */
export function troubleKind(message: string): 'service' | 'run' {
  return SERVICE_TROUBLE.test(message) && !RUN_TROUBLE.test(message) ? 'service' : 'run';
}

/** What `claude -p --output-format json` printed → the run, or an AgentError saying why not. */
export function parseClaudeResult(stdout: string): Omit<AgentRun, 'secrets'> {
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
 * Claude Code headless (`claude -p`) inside bubblewrap (sandbox.ts): the file tools over the WebUI
 * clone and the run's files, the service's Jira tool over loopback, no shell, no edits, no web,
 * no settings, no CLAUDE.md of its own. The bug comes in the prompt, the verdict comes back as
 * structured output. The MCP config with the run's secret is a 0600 file in a private temp
 * directory, bound into the sandbox; the command line (visible to every user of the machine)
 * holds no secret.
 */
export class ClaudeAgent implements Agent {
  private readonly opts: Config['agent'];
  private readonly webuiDir: string;
  private readonly tool: JiraTool;
  private readonly toolchainDir: string;
  private readonly claude: string;
  private readonly bwrap: string;
  private readonly dir: string;

  constructor(opts: Config['agent'], webuiDir: string, tool: JiraTool) {
    this.opts = opts;
    // bwrap runs from the run's directory: the clone's path must not depend on the working directory.
    this.webuiDir = resolve(webuiDir);
    this.tool = tool;
    // claude is the npm package under node's prefix: one read-only bind gives the sandbox both.
    this.toolchainDir = dirname(dirname(process.execPath));
    this.claude = join(this.toolchainDir, 'bin', 'claude');
    // Found on the service's PATH now, since the sandbox's own PATH is what the child gets.
    this.bwrap = onPath('bwrap') ?? 'bwrap';
    // mkdtemp makes it 0700 and unique: no other user can read it or create it first.
    this.dir = mkdtempSync(join(tmpdir(), 'bug-validator-'));
    process.once('exit', () => rmSync(this.dir, { recursive: true, force: true }));
  }

  /** The installed claude's version, asked inside the sandbox: proves bwrap and claude at start, not per bug. */
  async version(): Promise<string> {
    if (!existsSync(this.claude)) throw new AgentError(`cannot start claude: ${this.claude} does not exist (claude must be installed with npm under node's prefix)`, 'start');
    const runDir = mkdtempSync(join(this.dir, 'probe-'));
    try {
      const bugDir = join(runDir, 'bug');
      const mcpConfig = join(runDir, 'mcp.json');
      writeFileSync(mcpConfig, '{}', { mode: 0o600 });
      rmSync(bugDir, { force: true });
      writeFileSync(bugDir, ''); // bwrap binds a file as well as a directory; an empty one does here
      const out = await this.exec([...bwrapArgs(this.sandbox(bugDir, mcpConfig)), '--', this.claude, '--version'], '', runDir, 30_000);
      return out.trim();
    } catch (err) {
      if (err instanceof AgentError && err.kind === 'start') throw err;
      throw new AgentError(`cannot start claude in the sandbox: ${err instanceof Error ? err.message : String(err)}`, 'start');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  async run(prompt: string, jsonSchema: object, bugDir: string, signal?: AbortSignal): Promise<AgentRun> {
    // Read on every run, so an edit to the instructions reaches the next bug without a restart.
    const instructions = await readFile(INSTRUCTIONS, 'utf8');
    const runDir = mkdtempSync(join(this.dir, 'run-'));
    const secret = this.tool.grant();
    try {
      const mcpConfig = join(runDir, 'mcp.json');
      const server = { type: 'http', url: this.tool.url, headers: { Authorization: `Bearer ${secret}` } };
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { jira: server } }), { mode: 0o600 });
      const args = [
        ...bwrapArgs(this.sandbox(bugDir, mcpConfig)),
        '--', this.claude,
        '-p',
        '--model', this.opts.model,
        '--restricted',
        '--tools', FILE_TOOLS.join(','),
        '--add-dir', WORK_BUG,
        '--mcp-config', MCP_CONFIG,
        '--strict-mcp-config',
        '--allowedTools', [...FILE_TOOLS, ...JIRA_TOOLS].join(','),
        '--setting-sources', '',
        '--no-session-persistence',
        '--max-turns', String(this.opts.maxTurns),
        '--max-budget-usd', String(this.opts.maxBudgetUsd),
        '--output-format', 'json',
        '--json-schema', JSON.stringify(jsonSchema),
        '--system-prompt', instructions,
      ];
      const run = parseClaudeResult(await this.exec(args, prompt, runDir, this.opts.timeoutMs, signal));
      // A search that failed on Jira's side reads to the agent as "nothing found": a related bug
      // missed for no reason of the bug's. The run is not trusted.
      const failed = this.tool.failure(secret);
      if (failed) throw new AgentError(`Jira failed for the agent: ${failed.slice(0, 300)}`, 'service');
      return { ...run, model: this.opts.model, instructions: createHash('sha256').update(instructions).digest('hex').slice(0, 12), secrets: [secret, this.opts.token] };
    } finally {
      this.tool.revoke(secret);
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  private sandbox(bugDir: string, mcpConfig: string) {
    return { webuiDir: this.webuiDir, bugDir, mcpConfig, toolchainDir: this.toolchainDir };
  }

  /** The whole environment inside the sandbox; nothing of the service's but the Claude token. */
  private env(): Record<string, string> {
    return {
      HOME,
      PATH: `${this.toolchainDir}/bin:/usr/bin:/bin`,
      CLAUDE_CODE_OAUTH_TOKEN: this.opts.token,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }

  private exec(args: string[], stdin: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new AgentError('the service is stopping', 'stopped'));
    return new Promise((resolve, reject) => {
      const child = spawn(this.bwrap, args, { cwd, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let killedBy: AgentError | undefined;
      const kill = (reason: AgentError): void => {
        killedBy = reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill(new AgentError(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
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
        reject(new AgentError(`cannot start bwrap: ${e.message}`, e.code === 'ENOENT' ? 'start' : 'run'));
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

/** The program's path on PATH, or null. */
function onPath(program: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, program))) return join(dir, program);
  }
  return null;
}
