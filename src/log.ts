type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

function write(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(line + '\n');
}

/** One JSON line per event on stdout. The UI reads them: docs/architecture.md, Log. */
export const log = {
  info: (event: string, fields?: Fields): void => write('info', event, fields),
  warn: (event: string, fields?: Fields): void => write('warn', event, fields),
  error: (event: string, fields?: Fields): void => write('error', event, fields),
};

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
  return `${err.name}: ${err.message}${cause}`;
}
