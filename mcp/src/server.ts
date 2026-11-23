// Local / container HTTP server: npm start → http://127.0.0.1:3100/mcp
// (HOST=0.0.0.0 in a container; set MCP_TOKEN and MCP_ALLOWED_HOSTS for anything public.)
import { app, getHandler } from './app.js'
import { config } from './config.js'
import { NAME } from './mcp.js'
import { pool } from './db.js'

const { toolNames } = await getHandler().catch(async (err) => {
  console.error('[mcp] failed to start:', err instanceof Error ? err.message : err)
  await pool.end()
  process.exit(1)
})

const server = app.listen(config.port, config.host, () => {
  console.log(`[mcp] ${NAME} listening on http://${config.host}:${config.port}/mcp${config.mcpToken ? ' (Bearer token required)' : ''}`)
  console.log(`[mcp] Tools: ${toolNames.join(', ')}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))))
}
