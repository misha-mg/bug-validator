// `ui`: the web console, until SIGINT or SIGTERM.
import { resolve } from 'node:path'
import { log } from '../log.ts'
import { readBuild } from '../version.ts'
import { loadUiConfig } from '../http/config.ts'
import { startUi } from '../http/server.ts'

/** `ui`: the web UI, until SIGINT or SIGTERM. Reads the database and the log; writes nothing. */
export async function ui(): Promise<void> {
  // The code this console runs, read once: the footer names it on every page.
  const build = readBuild(resolve(import.meta.dirname, '../..'))
  const config = { ...loadUiConfig(), build }
  const server = await startUi(config)
  log.info('ui_start', {
    version: build.version,
    commit: build.commit,
    host: config.host,
    port: config.port,
    dbFile: config.dbFile,
    logFile: config.logFile,
  })
  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      log.info('ui_stopping', { signal })
      server.close(() => resolve())
      server.closeAllConnections()
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
  log.info('ui_stopped')
}
