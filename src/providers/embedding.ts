import crypto from 'node:crypto';
import type { ProviderHealth } from '../domain/types.js';
export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
  health(): Promise<ProviderHealth>;
}
export class LocalEmbedding implements EmbeddingProvider {
  name = 'local-deterministic';
  constructor(private dimensions = 128) {}
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = Array(this.dimensions).fill(0) as number[];
      for (const token of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        const h = crypto.createHash('sha256').update(token).digest();
        const i = h.readUInt32BE(0) % this.dimensions;
        v[i] = (v[i] ?? 0) + (h[4]! % 2 ? 1 : -1);
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
  async health() {
    return { provider: this.name, connected: true };
  }
}
export class OpenAIEmbedding implements EmbeddingProvider {
  name = 'openai-compatible';
  constructor(
    private base: string,
    private key: string | undefined,
    private model: string,
  ) {}
  async embed(texts: string[]) {
    if (!this.key) throw new Error('OPENAI_API_KEY is required');
    const r = await fetch(`${this.base}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!r.ok) throw new Error(`Embedding provider failed (${r.status})`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    return j.data.map((x) => x.embedding);
  }
  async health() {
    return {
      provider: this.name,
      connected: Boolean(this.key),
      detail: this.key ? 'configured' : 'missing credentials',
    };
  }
}
