// vitest: the project's own tests, never the WebUI clone's under state/ or a tool's under a dot directory.
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { exclude: ['**/node_modules/**', 'state/**', '.*/**'] } })
