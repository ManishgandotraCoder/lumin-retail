// Handles one chat turn end to end:
// LangGraph: router (Altrum checks input) -> Shopping or Support agent (tools / RAG / memory)
// -> reply (Altrum checks output) -> verdict mapped to what the customer sees.
// Each turn is one LangSmith trace when tracing is enabled.
import { RemoveMessage } from '@langchain/core/messages'
import { traceable } from 'langsmith/traceable'
import { conciergeGraph, type ConciergeStateType } from './agents/graph.js'
import { withTurnTrace } from './agents/context.js'
import type { Route } from './agents/agents.js'
import { withAltrumTracking, overallVerdict, type AltrumVerdict, type AltrumCall, type AltrumClient } from './llm/altrum.js'
import { audit } from './audit.js'
import { maskPII } from './pii.js'
import { config, type AltrumProvider } from './config.js'
import { langsmithClient } from './observability.js'

export const MESSAGES = {
  blocked: "Sorry, I can't help with that request. If you need help with an order or a product, please rephrase or contact Lumen support at support@lumenretail.example.",
  error: "Sorry, I'm having trouble right now. Please try again in a moment, or contact Lumen support at support@lumenretail.example.",
}

const AGENT_LABEL: Record<AltrumClient, string> = {
  router: 'Router agent',
  shopping: 'Shopping agent',
  support: 'Support agent',
}

export interface ChatTurnResult {
  reply: string
  provider: AltrumProvider
  model: string
  diagnostic?: string
  /** Which agent's call failed (router runs first, then shopping or support). */
  failedAgent?: AltrumClient
  verdict: AltrumVerdict
  route: Route | null
  tools: string[]
  sources: string[]
  altrum: Pick<AltrumCall, 'client' | 'endpoint' | 'verdict' | 'status' | 'action' | 'requestId'>[]
}

// If a turn fails or is blocked after the router accepted the message, undo what this turn
// wrote to the conversation state, so a blocked message doesn't stay in memory and the
// thread never ends on an unanswered customer message.
async function revertTurn(threadConfig: { configurable: { thread_id: string } }, beforeIds: Set<string>, previousRoute: Route | null) {
  const after = (await conciergeGraph.getState(threadConfig)).values as Partial<ConciergeStateType>
  const added = (after.messages ?? []).filter((m) => m.id && !beforeIds.has(m.id))
  if (!added.length && (after.route ?? null) === previousRoute) return
  // asNode 'shopping' = a terminal node, so the reverted checkpoint has nothing pending.
  await conciergeGraph.updateState(
    threadConfig,
    { messages: added.map((m) => new RemoveMessage({ id: m.id! })), route: previousRoute },
    'shopping',
  )
}

async function chatTurn(opts: {
  sessionId: string
  customerId: string
  message: string
  provider: AltrumProvider
  model: string
}): Promise<ChatTurnResult> {
  const { sessionId, customerId, provider, model } = opts
  // Altrum masks what reaches the model, but the conversation state is checkpointed BEFORE the
  // agent's gateway call. LOCAL_REDACT_INPUT=true masks it locally first, so card numbers etc.
  // never reach the checkpoint tables. (Off by default so Altrum's own masking can be tested.)
  const message = config.localRedactInput ? maskPII(opts.message) : opts.message
  const threadConfig = { configurable: { thread_id: sessionId } }
  const before = (await conciergeGraph.getState(threadConfig)).values as Partial<ConciergeStateType>
  const beforeIds = new Set((before.messages ?? []).map((m) => m.id).filter((id): id is string => !!id))
  const previousRoute: Route | null = before.route ?? null
  let route: Route | null = null

  const { trace, run } = withTurnTrace(() => withAltrumTracking(async () => {
    const state = await conciergeGraph.invoke(
      { input: message },
      {
        ...threadConfig,
        context: { customerId, sessionId, provider, model },
        metadata: { thread_id: sessionId, provider, model },
        tags: ['lumen-concierge'],
      },
    )
    route = state.route
    const last = state.messages.at(-1)
    return last?.getType() === 'ai' ? last.text : undefined
  }))
  const { result, error, calls } = await run
  const { tools, sources } = trace
  if (error || overallVerdict(calls, error) === 'blocked') {
    await revertTurn(threadConfig, beforeIds, previousRoute).catch((err) => console.error('[chat] could not revert turn', err))
  }
  if (!route && calls.some((c) => c.client !== 'router')) {
    route = (calls.find((c) => c.client !== 'router')!.client as Route)
  }

  const verdict = overallVerdict(calls, error)
  let reply: string
  if (verdict === 'blocked') reply = MESSAGES.blocked
  else if (verdict === 'error' || !result) reply = MESSAGES.error
  else reply = result

  if (error && verdict !== 'blocked') console.error('[chat] error:', error)
  const failedCall = calls.find((call) => call.verdict === 'error')
  let diagnostic: string | undefined
  let failedAgent: AltrumClient | undefined
  if (failedCall) {
    failedAgent = failedCall.client
    let reason = failedCall.reason ?? 'The provider rejected the request.'
    for (const key of new Set([config.altrum.routerApiKey, config.altrum.shoppingApiKey, config.altrum.supportApiKey])) {
      if (key) reason = reason.replaceAll(key, '[redacted key]')
    }
    diagnostic = `${AGENT_LABEL[failedAgent]} failed: Altrum HTTP ${failedCall.status} (${failedCall.client}/${failedCall.endpoint}): ${maskPII(reason).slice(0, 300)}`
  } else if (error && verdict === 'error') {
    // No HTTP response recorded: the router hadn't produced a route yet, or the routed agent failed.
    failedAgent = (route as Route | null) ?? 'router'
    diagnostic = `${AGENT_LABEL[failedAgent]} failed: no provider response was received. Check the server logs for details.`
  }

  await audit(sessionId, 'altrum_verdict', {
    verdict,
    route,
    provider,
    model,
    calls: calls.map(({ client, endpoint, verdict, status, action, requestId, reason }) => ({ client, endpoint, verdict, status, action, requestId, reason })),
  })
  await audit(sessionId, 'chat', { route, verdict, message: maskPII(message), tools })

  return {
    reply,
    provider,
    model,
    ...(diagnostic ? { diagnostic } : {}),
    ...(failedAgent ? { failedAgent } : {}),
    verdict,
    route,
    tools,
    sources: [...sources],
    altrum: calls.map(({ client, endpoint, verdict, status, action, requestId }) => ({ client, endpoint, verdict, status, action, requestId })),
  }
}

// Entry point used by the API: one LangSmith trace per chat turn (a no-op when tracing is off).
export function handleChatTurn(opts: Parameters<typeof chatTurn>[0]): Promise<ChatTurnResult> {
  return traceable(chatTurn, {
    name: 'chat_turn',
    run_type: 'chain',
    client: langsmithClient,
    tags: ['lumen-concierge', opts.provider],
    metadata: { thread_id: opts.sessionId, customer_id: opts.customerId, provider: opts.provider, model: opts.model },
  })(opts)
}
