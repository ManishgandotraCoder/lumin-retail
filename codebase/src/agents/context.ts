// Per-turn data that the server supplies, never the model.
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'

// LangGraph runtime context: passed with every graph.invoke(), read by nodes, middleware and tools.
export const turnContextSchema = z.object({
  customerId: z.string(),
  sessionId: z.string(),
  provider: z.enum(['openai', 'anthropic', 'gemini']),
  model: z.string(),
})
export type TurnContext = z.infer<typeof turnContextSchema>

// What happened during one chat turn (tools used, policy sources cited), for the API response.
export interface TurnTrace {
  tools: string[]
  sources: Set<string>
}
const turnStore = new AsyncLocalStorage<TurnTrace>()

export function withTurnTrace<T>(fn: () => Promise<T>): { trace: TurnTrace; run: Promise<T> } {
  const trace: TurnTrace = { tools: [], sources: new Set() }
  return { trace, run: turnStore.run(trace, fn) }
}

export function currentTurnTrace(): TurnTrace | undefined {
  return turnStore.getStore()
}
