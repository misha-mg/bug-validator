import { check } from './commands/check.ts';
import { requeue } from './commands/requeue.ts';
import { run } from './commands/run.ts';
import { log } from './log.ts';

const USAGE = `usage:
  node src/main.ts run             poll Jira and check new bugs (DRY_RUN=true by default)
  node src/main.ts check <KEY>     check one bug and print the result; writes nothing
  node src/main.ts requeue <KEY>   check a failed bug again at the next poll
`;

const [command, arg] = process.argv.slice(2);

// `check | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

try {
  if (command === 'run') {
    await run();
  } else if (command === 'check' && arg) {
    await check(arg);
  } else if (command === 'requeue' && arg) {
    requeue(arg);
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // The service's log is JSON lines; a fatal error is one too, so the TUI can show it.
  if (command === 'run') log.error('fatal', { error: message });
  else process.stderr.write(`${message}\n`);
  process.exit(1);
}
