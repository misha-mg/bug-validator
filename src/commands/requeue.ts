import { loadConfig } from '../config.ts';
import { Store } from '../db/store.ts';

/**
 * `requeue <KEY>`: a bug recorded as `failed` (or left `posting`) is checked again at the next
 * poll. The one supported way to re-run a bug; a row is never deleted.
 */
export function requeue(key: string): void {
  const store = new Store(loadConfig().dbFile);
  try {
    const before = store.status(key);
    if (store.requeue(key)) {
      process.stdout.write(`${key}: ${before} → retry; it is checked at the next poll\n`);
      return;
    }
    throw new Error(before === null ? `${key} is not in the database` : `${key} is ${before}; only failed or posting bugs are requeued`);
  } finally {
    store.close();
  }
}
