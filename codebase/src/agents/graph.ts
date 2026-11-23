// LangGraph orchestration for one chat turn:
//
//   START → router ─┬─► shopping_agent ─► END
//                   └─► support_agent  ─► END
//
// State is checkpointed in PostgreSQL per chat session (thread_id = session ID), so the
// conversation and the last route survive restarts and are shared by both agents.
import { Annotation, END, MessagesAnnotation, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { getChatModel } from '../llm/altrum.js'
import { ROUTER_PROMPT, shoppingAgent, supportAgent, type Route } from './agents.js'
import { turnContextSchema, type TurnContext } from './context.js'
import { checkpointer } from './memory.js'

export const ConciergeState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** The customer's latest message (added to `messages` only once the router accepts it). */
  input: Annotation<string>(),
  /** Agent that handled the last accepted turn; lets the router send short follow-ups to the same agent. */
  route: Annotation<Route | null>({ reducer: (_prev, next) => next, default: () => null }),
})
export type ConciergeStateType = typeof ConciergeState.State
type Config = LangGraphRunnableConfig<TurnContext>

function context(config: Config): TurnContext {
  if (!config.context) throw new Error('Missing turn context')
  return config.context
}

// Router: one-word classification. Altrum checks the customer's input on this call; if it
// blocks, the node throws and the message never enters the conversation state.
async function router(state: ConciergeStateType, config: Config) {
  const { provider, model } = context(config)
  const res = await getChatModel('router', provider, model).invoke(
    [
      new SystemMessage(ROUTER_PROMPT),
      new HumanMessage(`Previous agent: ${state.route ?? 'none'}\nCustomer message: ${state.input}`),
    ],
    { runName: 'router_classify' },
  )
  const route: Route = /support/i.test(res.text ?? '') ? 'support' : 'shopping'
  return { route, messages: [new HumanMessage(state.input)] }
}

// Each specialist is a LangChain agent (model ↔ tools loop) run on the shared conversation.
function specialist(agent: typeof shoppingAgent | typeof supportAgent) {
  return async (state: ConciergeStateType, config: Config) => {
    const result = await agent.invoke({ messages: state.messages }, { context: context(config), recursionLimit: 14 })
    return { messages: result.messages.slice(state.messages.length) }
  }
}

export const conciergeGraph = new StateGraph(ConciergeState, turnContextSchema)
  .addNode('router', router)
  .addNode('shopping', specialist(shoppingAgent))
  .addNode('support', specialist(supportAgent))
  .addEdge(START, 'router')
  .addConditionalEdges('router', (state) => state.route ?? 'shopping', ['shopping', 'support'])
  .addEdge('shopping', END)
  .addEdge('support', END)
  .compile({ checkpointer, name: 'lumen_concierge' })
