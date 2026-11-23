// Policy RAG: LangChain PGVectorStore over lumen_policies (id uuid, text text, metadata jsonb, embedding vector(768)).
import { PGVectorStore } from '@langchain/pgvector'
import { config } from './config.js'
import { pool } from './db.js'
import { policyEmbeddings } from './embeddings.js'

const policyVectorStore = new PGVectorStore(policyEmbeddings, {
  pool,
  tableName: config.policyIndex,
  distanceStrategy: 'cosine',
  // Return 1 - cosine distance, so higher = more similar.
  scoreNormalization: 'similarity',
})

export interface PolicyPassage {
  text: string
  source: string
  title: string
  section: string | null
  version: string | null
  score: number
}

// Retrieve the most relevant approved policy passages for a question.
export async function searchPolicies(question: string, topK = 4, minScore = 0.2): Promise<PolicyPassage[]> {
  const results = await policyVectorStore.similaritySearchWithScore(question, topK)
  return results
    .filter(([, score]) => score >= minScore)
    .map(([doc, score]) => ({
      text: doc.pageContent,
      source: doc.metadata.source,
      title: doc.metadata.title,
      section: doc.metadata.section ?? null,
      version: doc.metadata.version ?? null,
      score: Number(score.toFixed(3)),
    }))
}
