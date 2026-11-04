/**
 * What the agent sees: the bubblewrap arguments (docs/architecture.md, The agent run). The agent
 * reads files, so claude's flags alone cannot keep it from the rest of the machine — the service's
 * `.env`, `~/.claude`, `state/`. Inside the sandbox there is the system (read-only), the toolchain
 * (node and claude, read-only), the WebUI clone and the run's files (read-only), an empty home and
 * tmp that vanish with the run, and the network, which claude needs for the API and for the
 * service's Jira tool on loopback. The environment inside is the one bwrap is started with
 * (agent.ts gives it a small one of its own): the Claude token goes that way, never as an
 * argument, since a command line is visible to every user of the machine.
 */

/** The clone, the working directory. */
export const WORK_WEBUI = '/work/webui'
/** The run's files (pipeline/attachments.ts). */
export const WORK_BUG = '/work/bug'
export const HOME = '/home/agent'
/** The MCP config, read by claude; the agent's Read can see it too, so its secret is one the guardrails refuse. */
export const MCP_CONFIG = `${HOME}/mcp.json`

export interface Sandbox {
  webuiDir: string
  bugDir: string
  /** The file with the MCP server's URL and the run's secret. */
  mcpConfig: string
  /** The prefix that holds node and claude (`<prefix>/bin`, `<prefix>/lib/node_modules`). */
  toolchainDir: string
}

/** The bwrap argv, up to and excluding the command. */
export function bwrapArgs(s: Sandbox): string[] {
  return [
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/sbin',
    '/sbin',
    // Name resolution and TLS; `-try` for files a system may not have.
    '--ro-bind',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--ro-bind-try',
    '/etc/hosts',
    '/etc/hosts',
    '--ro-bind-try',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--ro-bind-try',
    '/etc/ssl',
    '/etc/ssl',
    '--ro-bind-try',
    '/etc/ca-certificates',
    '/etc/ca-certificates',
    '--ro-bind-try',
    '/etc/localtime',
    '/etc/localtime',
    // Who the process is, for libraries that ask; nothing secret in these.
    '--ro-bind-try',
    '/etc/passwd',
    '/etc/passwd',
    '--ro-bind-try',
    '/etc/group',
    '/etc/group',
    '--ro-bind',
    s.toolchainDir,
    s.toolchainDir,
    '--ro-bind',
    s.webuiDir,
    WORK_WEBUI,
    '--ro-bind',
    s.bugDir,
    WORK_BUG,
    '--tmpfs',
    HOME,
    '--ro-bind',
    s.mcpConfig,
    MCP_CONFIG,
    '--tmpfs',
    '/tmp',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--unshare-all',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    WORK_WEBUI,
  ]
}
