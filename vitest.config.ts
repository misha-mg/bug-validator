// vitest: the project's own tests, never the WebUI clone's under state/.
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { exclude: ['**/node_modules/**', 'state/**'] } })
