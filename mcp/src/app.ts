// Express app: MCP over Streamable HTTP at /mcp (stateless, one MCP server per request) + /health.
// Used by `npm start` (src/server.ts) and by Vercel (api/index.ts).
import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from 'express'
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from '@modelcontextprotocol/server'
import { config, serverless } from './config.js'
import { NAME, buildServer, resolveTools, tokenMatches } from './mcp.js'

// Host / Origin allowlist (DNS-rebinding protection). MCP_ALLOWED_HOSTS wins; locally default to localhost.
// On Vercel without a list, the Bearer token is the gate.
const allowedHosts = config.allowedHosts ?? (serverless ? undefined : localhostAllowedHostnames())

// Resolved once per process / Vercel instance; retried on the next request if it failed (e.g. DB down).
let handlerPromise: Promise<{ handler: ReturnType<typeof createMcpHandler>; toolNames: string[] }> | undefined
export function getHandler() {
  handlerPromise ??= resolveTools({ http: true })
    .then((tools) => ({ handler: createMcpHandler(() => buildServer(tools)), toolNames: tools.map((t) => t.name) }))
    .catch((err) => {
      handlerPromise = undefined
      throw err
    })
  return handlerPromise
}

// Express request -> web-standard Request for the SDK handler (body already parsed by express.json()).
function toWebRequest(req: ExpressRequest): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.set(k, v)
  }
  headers.delete('content-length')
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
  return new Request(`${req.protocol}://${req.headers.host ?? 'localhost'}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
  })
}

async function sendWebResponse(res: ExpressResponse, response: Response) {
  res.status(response.status)
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) return res.end()
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

export const app = express()
app.disable('x-powered-by')

app.get(['/', '/health'], (_req, res) => {
  res.json({ ok: true, name: NAME, mcp: '/mcp' })
})

app.all(
  '/mcp',
  (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    // A public deployment must not run open.
    if (serverless && !config.mcpToken) return res.status(500).json({ error: 'MCP_TOKEN is not configured on the server' })
    if (!tokenMatches(req.headers.authorization)) {
      return res.status(401).set('www-authenticate', 'Bearer').json({ error: 'Unauthorized' })
    }
    next()
  },
  express.json({ limit: '4mb' }),
  async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const request = toWebRequest(req)
      if (allowedHosts) {
        const rejected = hostHeaderValidationResponse(request, allowedHosts) ?? originValidationResponse(request, allowedHosts)
        if (rejected) return sendWebResponse(res, rejected)
      }
      const { handler } = await getHandler()
      await sendWebResponse(res, await handler.fetch(request))
    } catch (err) {
      console.error('[mcp] request failed', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
      else res.end()
    }
  },
)

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})
