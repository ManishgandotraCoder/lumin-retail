import path from 'node:path'
import dotenv from 'dotenv'

// Load this project's .env by path, so stdio clients started from another folder still find it.
// On Vercel there is no .env file; variables come from the project settings.
dotenv.config({ path: path.resolve(import.meta.dirname, '../.env'), quiet: true })

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}
function required(name: string): string {
  const value = optional(name)
  if (!value) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`)
  return value
}

// local       = FastEmbed on CPU (onnxruntime + ~200MB weights, downloaded once and cached)
// huggingface = same model via the Hugging Face Inference API; use this on Vercel
const embeddingProvider = (optional('EMBEDDING_PROVIDER')?.toLowerCase() ?? 'local') as 'local' | 'huggingface'
if (embeddingProvider !== 'local' && embeddingProvider !== 'huggingface') {
  throw new Error('EMBEDDING_PROVIDER must be local or huggingface')
}
const hfToken = optional('HF_TOKEN')
if (embeddingProvider === 'huggingface' && !hfToken) throw new Error('EMBEDDING_PROVIDER=huggingface needs HF_TOKEN')

export const serverless = Boolean(process.env.VERCEL)

export const config = {
  port: Number(process.env.PORT ?? 3100),
  host: optional('HOST') ?? '127.0.0.1',
  databaseUrl: required('DATABASE_URL'),
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? (serverless ? 3 : 10)),

  // Bearer token for HTTP. Required on Vercel and whenever order tools are exposed over HTTP.
  mcpToken: optional('MCP_TOKEN'),
  // Comma-separated Host names accepted over HTTP (e.g. mcp.example.com). Unset = localhost only,
  // except on Vercel where the token is the gate.
  allowedHosts: optional('MCP_ALLOWED_HOSTS')?.split(',').map((h) => h.trim()).filter(Boolean),
  // Expose order tools for this ONE customer only. Callers can never choose the customer.
  customerId: optional('LUMEN_CUSTOMER_ID'),

  embeddingProvider,
  hfToken,
  hfEmbeddingUrl:
    optional('HF_EMBEDDING_URL') ??
    'https://router.huggingface.co/hf-inference/models/BAAI/bge-base-en-v1.5/pipeline/feature-extraction',
  embeddingCacheDir: optional('EMBEDDING_CACHE_DIR') ?? 'node_modules/.cache/fastembed',
  embeddingDim: 768,
  policyIndex: 'lumen_policies',
}
