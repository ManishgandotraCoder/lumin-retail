import { policyVectorStore } from './vectorStore.js'

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
