// Conversation memory: LangGraph's PostgreSQL checkpointer.
// One thread per chat session (thread_id = session ID). Tables: checkpoints, checkpoint_blobs,
// checkpoint_writes, checkpoint_migrations, created by setupMemory().
// Both agents share the thread, so a follow-up handled by a different agent sees the earlier
// conversation. The agents only send the last MEMORY_LAST_MESSAGES messages to the model.
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { pool } from '../db/pool.js'

export const checkpointer = new PostgresSaver(pool)

export async function setupMemory() {
  await checkpointer.setup()
}

// Right to erasure: delete everything LangGraph stored for this chat.
export async function deleteMemory(sessionId: string) {
  await checkpointer.deleteThread(sessionId)
}
