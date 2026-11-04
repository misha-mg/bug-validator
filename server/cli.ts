// The command line: run | check <KEY> [--recheck] | request <KEY|URL> | ui | maintain; bin/bug-validator execs it.
import { check } from './commands/check.ts'
import { maintain } from './commands/maintain.ts'
import { request } from './commands/request.ts'
import { run } from './commands/run.ts'
import { ui } from './commands/ui.ts'
import { log } from './log.ts'

const USAGE = `usage:
  node server/cli.ts run             poll Jira and check new bugs (VALIDATOR_DRY_RUN=true by default)
  node server/cli.ts check <KEY>     check one bug and print the result; writes nothing
    [--recheck]                    as a re-check: the agent edits the comment recorded for the bug
  node server/cli.ts request <KEY|URL>  the running service checks the bug next, whatever its state
  node server/cli.ts ui              serve the web UI (VALIDATOR_HOST, VALIDATOR_PORT); reads the database and the log
  node server/cli.ts maintain        back up the database, cut the log down to size (daily, from a timer)
`

const [command, arg, ...flags] = process.argv.slice(2)

// `check | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

try {
  if (command === 'run') {
    await run()
  } else if (command === 'check' && arg && flags.every((f) => f === '--recheck')) {
    await check(arg, flags.includes('--recheck'))
  } else if (command === 'request' && arg) {
    request(arg)
  } else if (command === 'ui' && !arg) {
    await ui()
  } else if (command === 'maintain' && !arg) {
    maintain()
  } else {
    process.stderr.write(USAGE)
    process.exit(2)
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  // The service's log is JSON lines; a fatal error is one too, so the UI can show it.
  if (command === 'run' || command === 'ui') log.error('fatal', { error: message })
  else process.stderr.write(`${message}\n`)
  process.exit(1)
}
