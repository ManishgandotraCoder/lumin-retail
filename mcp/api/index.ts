// Vercel Function entry: the Express app handles every path (see vercel.json rewrite).
// The app is imported lazily so a startup error (e.g. a missing env variable) is returned as a
// readable 500 instead of Vercel's opaque FUNCTION_INVOCATION_FAILED. Messages name variables,
// never their values.
import type { IncomingMessage, ServerResponse } from 'node:http'

const appPromise = import('../src/app.js').then((m) => m.app)

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let app
  try {
    app = await appPromise
  } catch (err) {
    console.error('[mcp] startup failed', err)
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'MCP server failed to start', reason: err instanceof Error ? err.message : String(err) }))
    return
  }
  return (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
}
