import path from 'node:path'
import dotenv from 'dotenv'

// Load the project's .env by path, so scripts started from another folder still find it.
dotenv.config({ path: path.resolve(import.meta.dirname, '../.env'), quiet: true })

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`)
  return value
}

export type AltrumProvider = 'openai' | 'anthropic' | 'gemini'

export const DEFAULT_LLM_MODELS: Record<AltrumProvider, string> = {
  openai: 'openai/gpt-4o-mini',
  anthropic: 'anthropic/claude-sonnet-4-5',
  gemini: 'gemini/gemini-3.6-flash',
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function isAltrumProvider(value: string): value is AltrumProvider {
  return value === 'openai' || value === 'anthropic' || value === 'gemini'
}

const altrumProviderValue = process.env.ALTRUM_PROVIDER?.trim().toLowerCase() || 'openai'
if (!isAltrumProvider(altrumProviderValue)) {
  throw new Error('ALTRUM_PROVIDER must be one of: openai, anthropic, gemini')
}
const altrumProvider = altrumProviderValue
const providerModelEnv: Record<AltrumProvider, string> = {
  openai: 'OPENAI_LLM_MODEL',
  anthropic: 'ANTHROPIC_LLM_MODEL',
  gemini: 'GEMINI_LLM_MODEL',
}
const providerSpecificModel = optional(providerModelEnv[altrumProvider])
const legacyModel = optional('LLM_MODEL')
const recognizedModelPrefix = legacyModel?.match(/^(openai|anthropic|gemini)\//)?.[1]
const providerModelPrefix = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini' }[altrumProvider]
const compatibleLegacyModel = legacyModel
  && (!recognizedModelPrefix
    ? altrumProvider === 'openai' || legacyModel.startsWith('claude-') || legacyModel.startsWith('gemini-')
    : recognizedModelPrefix === providerModelPrefix)
    ? legacyModel
    : undefined
const configuredLlmModel = providerSpecificModel ?? compatibleLegacyModel
if (providerSpecificModel && /^(openai|anthropic|gemini)\//.test(providerSpecificModel)
  && !providerSpecificModel.startsWith(`${providerModelPrefix}/`)) {
  throw new Error(`${providerModelEnv[altrumProvider]} must use the ${providerModelPrefix}/ model prefix`)
}
const llmModel = configuredLlmModel
  ? configuredLlmModel.startsWith(`${providerModelPrefix}/`)
    ? configuredLlmModel
    : `${providerModelPrefix}/${configuredLlmModel}`
  : DEFAULT_LLM_MODELS[altrumProvider]

function providerBaseURL(provider: 'openai' | 'anthropic' | 'gemini', configuredBaseURL: string) {
  const baseURL = configuredBaseURL.replace(/\/+$/, '')
  if (provider === 'openai') {
    if (/\/openai\/v1$/.test(baseURL) || /\/v1$/.test(baseURL)) return baseURL
    return `${baseURL}/openai/v1`
  }
  if (provider === 'anthropic') {
    if (/\/anthropic\/v1$/.test(baseURL)) return baseURL
    if (/\/anthropic$/.test(baseURL)) return `${baseURL}/v1`
    return `${baseURL.replace(/\/(openai\/v1|genai\/v1beta|v1)$/, '')}/anthropic/v1`
  }
  if (/\/genai\/v1beta$/.test(baseURL)) return baseURL
  if (/\/genai$/.test(baseURL)) return `${baseURL}/v1beta`
  return `${baseURL.replace(/\/(openai\/v1|anthropic\/v1|anthropic|v1)$/, '')}/genai/v1beta`
}

const altrumApiKey = required('ALTRUM_API_KEY')
const shoppingAltrumApiKey = optional('ALTRUM_SHOPPING_API_KEY')
const supportAltrumApiKey = optional('ALTRUM_SUPPORT_API_KEY')
const altrumBaseURL = required('ALTRUM_BASE_URL')
const altrumProviderBaseURLs: Record<AltrumProvider, string> = {
  openai: providerBaseURL('openai', altrumBaseURL),
  anthropic: providerBaseURL('anthropic', altrumBaseURL),
  gemini: providerBaseURL('gemini', altrumBaseURL),
}
const embeddingProvider = optional('EMBEDDING_PROVIDER')?.toLowerCase() ?? 'local'
if (embeddingProvider !== 'local') {
  throw new Error('EMBEDDING_PROVIDER must be local')
}
const defaultLlmModels = {
  ...DEFAULT_LLM_MODELS,
  [altrumProvider]: llmModel,
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  staffToken: process.env.STAFF_TOKEN ?? 'change-me-staff-token',
  databaseUrl: required('DATABASE_URL'),

  altrum: {
    provider: altrumProvider,
    baseURL: altrumProviderBaseURLs[altrumProvider],
    providerBaseURLs: altrumProviderBaseURLs,
    defaultModels: defaultLlmModels,
    routerApiKey: altrumApiKey,
    shoppingApiKey: shoppingAltrumApiKey ?? altrumApiKey,
    supportApiKey: supportAltrumApiKey ?? altrumApiKey,
    usesSharedShoppingKey: !supportAltrumApiKey,
    usesSharedSupportKey: !shoppingAltrumApiKey,
    actionHeader: (process.env.ALTRUM_ACTION_HEADER ?? 'x-altrum-action').toLowerCase(),
    blockStatus: (process.env.ALTRUM_BLOCK_STATUS ?? '400,403,422,451')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  },

  llmModel,
  usesProviderDefaultModel: !configuredLlmModel,
  ignoresLegacyLlmModel: Boolean(legacyModel && !compatibleLegacyModel && !providerSpecificModel),
  embeddingProvider,
  embeddingCacheDir: optional('EMBEDDING_CACHE_DIR') ?? 'node_modules/.cache/fastembed',
  embeddingDim: 768,
  memoryLastMessages: Number(process.env.MEMORY_LAST_MESSAGES ?? 12),

  // Lumen MCP server (../mcp, run locally with `npm start` there): catalogue, stock and policy tools are called there.
  mcp: {
    url: optional('MCP_URL') ?? 'http://127.0.0.1:3100/mcp',
    token: optional('MCP_TOKEN'),
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS ?? 30_000),
  },
  localRedactInput: process.env.LOCAL_REDACT_INPUT === 'true',

  policyIndex: 'lumen_policies',
}
