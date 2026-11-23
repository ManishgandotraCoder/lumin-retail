// stdio transport for local MCP clients (Claude Desktop, Claude Code, Cursor): the client starts this process.
// stdout carries the MCP protocol only, so every console.log (ours or a library's) goes to stderr.
console.log = console.error
console.info = console.error
console.debug = console.error

const { serveStdio } = await import('@modelcontextprotocol/server/stdio')
const { NAME, buildServer, resolveTools } = await import('./mcp.js')
const { pool } = await import('./db.js')

try {
  const tools = await resolveTools({ http: false })
  serveStdio(() => buildServer(tools))
  console.error(`[mcp] ${NAME} on stdio. Tools: ${tools.map((t) => t.name).join(', ')}`)
} catch (err) {
  console.error('[mcp] failed to start:', err instanceof Error ? err.message : err)
  await pool.end()
  process.exit(1)
}

export {}
