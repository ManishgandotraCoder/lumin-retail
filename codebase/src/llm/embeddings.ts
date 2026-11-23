// Local policy embeddings (FastEmbed, BAAI/bge-base-en-v1.5, CPU) as a LangChain Embeddings class.
// Weights download once from Hugging Face and are cached; no embedding API calls are made.
import { Embeddings } from '@langchain/core/embeddings'
import { EmbeddingModel, FlagEmbedding } from 'fastembed'
import { config } from '../config.js'

export class LocalBgeEmbeddings extends Embeddings {
  private modelPromise: Promise<FlagEmbedding> | undefined

  constructor() {
    super({})
  }

  private model(): Promise<FlagEmbedding> {
    this.modelPromise ??= FlagEmbedding.init({
      model: EmbeddingModel.BGEBaseENV15,
      cacheDir: config.embeddingCacheDir,
    })
    return this.modelPromise
  }

  // BGE uses different prefixes for passages and queries, so the two methods differ.
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const model = await this.model()
    const vectors: number[][] = []
    for await (const batch of model.passageEmbed(texts)) vectors.push(...batch.map((v) => Array.from(v)))
    return vectors
  }

  async embedQuery(text: string): Promise<number[]> {
    return Array.from(await (await this.model()).queryEmbed(text))
  }
}

export const policyEmbeddings = new LocalBgeEmbeddings()
