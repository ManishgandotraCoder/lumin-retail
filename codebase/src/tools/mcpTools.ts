// Catalogue, stock and policy tools come from the Lumen MCP server (../mcp, deployed on Vercel),
// loaded as LangChain tools. Names, descriptions and input schemas are defined there, not here.
//
// Order tools stay local (supportTools.ts): they act for the logged-in customer of each chat
// session, which the shared MCP server cannot know.
import { MCPAdapter } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { config } from '../config.js'

export const REMOTE_TOOL_NAMES = ['search_products', 'check_inventory', 'search_policies'] as const
type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number]

export const mcpClient = new MCPAdapter({
  servers: {
    lumen: {
      transport: 'http',
      url: config.mcp.url,
      headers: config.mcp.token ? { authorization: `Bearer ${config.mcp.token}` } : undefined,
    },
  },
  prefixToolNameWithServerName: false,
  defaultToolTimeout: config.mcp.timeoutMs,
})

// Loaded once at startup; the app does not start without its tools.
const tools = await mcpClient.listTools().catch((err) => {
  throw new Error(`Could not load tools from the MCP server at ${config.mcp.url} (check MCP_URL / MCP_TOKEN): ${err?.message ?? err}`)
})

const byName = new Map(tools.map((t) => [t.name, t as StructuredToolInterface]))
const missing = REMOTE_TOOL_NAMES.filter((name) => !byName.has(name))
if (missing.length) throw new Error(`MCP server at ${config.mcp.url} does not provide: ${missing.join(', ')}`)

export const mcpTool = (name: RemoteToolName) => byName.get(name)!
