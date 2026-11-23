// MCP server definition shared by the HTTP app (Express / Vercel) and stdio.
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { audit } from './audit.js'
import { config } from './config.js'
import { query } from './db.js'
import { customerTools, publicTools, type ToolDef } from './tools.js'

export const NAME = 'lumen-concierge'

// Public tools, plus the order tools when LUMEN_CUSTOMER_ID names a known customer.
// Over HTTP the order tools also require MCP_TOKEN.
export async function resolveTools({ http }: { http: boolean }): Promise<ToolDef[]> {
  const tools = [...publicTools]
  if (config.customerId) {
    const [customer] = await query('SELECT customer_id FROM customers WHERE customer_id = $1', [config.customerId])
    if (!customer) throw new Error(`LUMEN_CUSTOMER_ID ${config.customerId} is not a known customer`)
    if (http && !config.mcpToken) throw new Error('Over HTTP, order tools need MCP_TOKEN. Set MCP_TOKEN or unset LUMEN_CUSTOMER_ID.')
    tools.push(...customerTools)
  }
  return tools
}

export function buildServer(tools: ToolDef[]) {
  const server = new McpServer(
    { name: NAME, version: '1.0.0' },
    {
      instructions:
        'Lumen Retail (India) catalogue, stock and policy tools. Prices are INR. Answer policy questions only from search_policies passages and cite the title.' +
        (config.customerId ? ` Order tools act for customer ${config.customerId} only; returns are created as pending staff approval.` : ''),
    },
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema as any,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const entry = { agent: 'mcp', tool: tool.name, input: args, customerId: config.customerId }
        try {
          const output = await tool.run(tool.schema.parse(args ?? {}))
          await audit({ ...entry, ok: true })
          return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] }
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          await audit({ ...entry, ok: false, error: message })
          return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
        }
      },
    )
  }
  return server
}

// Bearer check (constant time). No MCP_TOKEN configured = open.
export function tokenMatches(header: string | undefined | null) {
  if (!config.mcpToken) return true
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(config.mcpToken)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}
