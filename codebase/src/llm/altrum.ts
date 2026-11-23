// Altrum AI integration.
//
// Chat calls use the selected OpenAI, Anthropic, or Gemini Altrum endpoint.
// Altrum applies the guardrails. Our job is only to READ Altrum's verdict and show the right thing:
//
//   allowed -> show the reply
//   blocked -> show a fixed safe message
//   masked  -> show the reply Altrum returned (sensitive parts already hidden)
//   error   -> show a fallback message and log it
//
// How Altrum reports its verdict (header name, block status codes) is configured in
// .env (ALTRUM_ACTION_HEADER, ALTRUM_BLOCK_STATUS). If Altrum's real format differs,
// change interpretResponse() below; nothing else in the app needs to change.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { config, type AltrumProvider } from '../config.js'

export type AltrumVerdict = 'allowed' | 'blocked' | 'masked' | 'error'
export type AltrumClient = 'router' | 'shopping' | 'support'

export interface AltrumCall {
  verdict: AltrumVerdict
  client: AltrumClient
  status: number
  action?: string
  reason?: string
  requestId?: string
  endpoint: string
}

// Collects the verdict of every gateway call made while handling one chat message.
interface VerdictStore {
  calls: AltrumCall[]
}
const verdictStore = new AsyncLocalStorage<VerdictStore>()

export class AltrumBlockedError extends Error {
  constructor(public call: AltrumCall) {
    super(`Altrum blocked the request${call.reason ? `: ${call.reason}` : ''}`)
    this.name = 'AltrumBlockedError'
  }
}

/** Run fn and collect every Altrum verdict produced inside it. */
export async function withAltrumTracking<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; calls: AltrumCall[] }> {
  const store: VerdictStore = { calls: [] }
  return verdictStore.run(store, async () => {
    try {
      const result = await fn()
      return { result, calls: store.calls }
    } catch (error) {
      return { error, calls: store.calls }
    }
  })
}

/** Combine all calls for one chat turn into a single verdict for the UI. */
export function overallVerdict(calls: AltrumCall[], error?: unknown): AltrumVerdict {
  if (calls.some((c) => c.verdict === 'blocked') || error instanceof AltrumBlockedError) return 'blocked'
  if (error) return 'error'
  if (calls.some((c) => c.verdict === 'error')) return 'error'
  if (calls.some((c) => c.verdict === 'masked')) return 'masked'
  return 'allowed'
}

async function readReason(res: Response): Promise<string | undefined> {
  try {
    const body: any = await res.clone().json()
    return body?.error?.message ?? body?.message ?? body?.reason ?? undefined
  } catch {
    return undefined
  }
}

// ---- The one place that knows Altrum's response format ----
async function interpretResponse(res: Response, endpoint: string, client: AltrumClient): Promise<AltrumCall> {
  const action = res.headers.get(config.altrum.actionHeader)?.toLowerCase() ?? undefined
  const requestId = res.headers.get('x-altrum-request-id') ?? res.headers.get('x-request-id') ?? undefined
  const base = { status: res.status, action, requestId, endpoint, client }

  if (action && /block|deny|reject/.test(action)) {
    return { ...base, verdict: 'blocked', reason: await readReason(res) }
  }
  if (!res.ok && config.altrum.blockStatus.includes(res.status)) {
    const reason = await readReason(res)
    // Treat as a guardrail block only if the body says so; otherwise it's a normal API error.
    if (!reason || /guardrail|block|policy|violation|denied|unsafe|injection/i.test(reason)) {
      return { ...base, verdict: 'blocked', reason }
    }
    return { ...base, verdict: 'error', reason }
  }
  if (!res.ok) return { ...base, verdict: 'error', reason: await readReason(res) }
  if (action && /mask|redact|modif|anonymi/.test(action)) return { ...base, verdict: 'masked' }
  return { ...base, verdict: 'allowed' }
}

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis)
const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

async function recordVerdict(client: AltrumClient, input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const endpoint = new URL(urlOf(input)).pathname.split('/').slice(-2).join('/')
  const res = await realFetch(input, init)
  const call = await interpretResponse(res, endpoint, client)
  verdictStore.getStore()?.calls.push(call)
  if (call.verdict === 'blocked') throw new AltrumBlockedError(call)
  return res
}

// OpenAI and Anthropic SDKs accept a custom fetch: it records Altrum's verdict for the agent.
function trackedFetch(client: AltrumClient): typeof fetch {
  return (input, init) => recordVerdict(client, input, init)
}

// The Gemini SDK always uses the global fetch, so Gemini models tag their requests with this
// header and a global wrapper records the verdict (the header is removed before sending).
const CLIENT_HEADER = 'x-lumen-agent'
let geminiFetchInstalled = false
function installGeminiFetchTracking() {
  if (geminiFetchInstalled) return
  geminiFetchInstalled = true
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const client = headers.get(CLIENT_HEADER) as AltrumClient | null
    if (!client || !urlOf(input).startsWith(config.altrum.providerBaseURLs.gemini)) return realFetch(input, init)
    headers.delete(CLIENT_HEADER)
    return recordVerdict(client, input, { ...init, headers })
  }
}

function apiKeyFor(client: AltrumClient) {
  // Shopping/Support key mapping is intentional: see ALTRUM_*_API_KEY comments in .env.example.
  if (client === 'router') return config.altrum.routerApiKey
  return client === 'shopping' ? config.altrum.supportApiKey : config.altrum.shoppingApiKey
}

// maxRetries 0: a blocked call must not be retried, and every call is counted once.
function buildChatModel(client: AltrumClient, provider: AltrumProvider, model: string): BaseChatModel {
  const apiKey = apiKeyFor(client)
  const baseURL = config.altrum.providerBaseURLs[provider]
  switch (provider) {
    case 'openai':
      return new ChatOpenAI({
        model,
        apiKey,
        maxRetries: 0,
        useResponsesApi: false,
        configuration: { baseURL, fetch: trackedFetch(client) },
      })
    case 'anthropic':
      // The Anthropic SDK appends /v1/messages itself.
      return new ChatAnthropic({
        model,
        apiKey,
        maxRetries: 0,
        clientOptions: { baseURL: baseURL.replace(/\/v1$/, ''), fetch: trackedFetch(client) },
      })
    case 'gemini':
      installGeminiFetchTracking()
      // The Gemini SDK builds <baseUrl>/<apiVersion>/models/<model>:generateContent.
      return new ChatGoogleGenerativeAI({
        model,
        apiKey,
        maxRetries: 0,
        baseUrl: baseURL.replace(/\/v1beta$/, ''),
        apiVersion: 'v1beta',
        customHeaders: { [CLIENT_HEADER]: client },
      })
  }
}

// One model instance per (agent, provider, model); verdict tracking is per request via AsyncLocalStorage.
const modelCache = new Map<string, BaseChatModel>()
export function getChatModel(client: AltrumClient, provider: AltrumProvider, model: string): BaseChatModel {
  const key = `${client}|${provider}|${model}`
  let chatModel = modelCache.get(key)
  if (!chatModel) {
    chatModel = buildChatModel(client, provider, model)
    modelCache.set(key, chatModel)
  }
  return chatModel
}
