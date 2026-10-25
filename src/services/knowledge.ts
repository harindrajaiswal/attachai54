import crypto from 'node:crypto';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { VectorProvider } from '../providers/vector.js';
import type { ObjectStorage } from '../providers/storage.js';
import { chunks, parseDocument } from './parser.js';
import type { Repository } from '../repositories/repository.js';
export class KnowledgeService {
  constructor(
    private storage: ObjectStorage,
    private embeddings: EmbeddingProvider,
    private vectors: VectorProvider,
    private repo?: Repository,
  ) {}
  async upload(clientId: string, name: string, data: Buffer) {
    const text = await parseDocument(name, data);
    if (!text.trim()) throw new Error('Document contains no text');
    await this.storage.put(clientId, name, data);
    const parts = chunks(text);
    const e = await this.embeddings.embed(parts);
    await this.vectors.replaceSource(
      clientId,
      name,
      parts.map((x, i) => ({
        // Stable IDs make reindexing deterministic and prevent duplicate chunks.
        id: crypto.createHash('sha256').update(`${clientId}\0${name}\0${i}\0${x}`).digest('hex'),
        clientId,
        source: name,
        text: x,
        embedding: e[i]!,
      })),
    );
    await this.repo?.saveKnowledge(clientId, name, data.byteLength, parts.length, 'ready');
    return {
      filename: name,
      size: data.byteLength,
      chunks: parts.length,
      embeddingStatus: 'ready',
    };
  }
  async list(clientId: string) {
    const metadata = (await this.repo?.knowledge(clientId)) as
      | Array<{ filename: string; size: number; chunks: number; status: string; updatedAt: string }>
      | undefined;
    if (metadata?.length)
      return metadata.map((x) => ({ ...x, bytes: x.size, embeddingStatus: x.status }));
    const names = await this.storage.list(clientId);
    return Promise.all(
      names.map(async (filename) => ({
        filename,
        size: (await this.storage.read(clientId, filename)).byteLength,
        bytes: (await this.storage.read(clientId, filename)).byteLength,
        chunks: 0,
        embeddingStatus: 'unknown',
      })),
    );
  }
  async remove(clientId: string, filename: string) {
    await this.storage.remove(clientId, filename);
    await this.repo?.removeKnowledge(clientId, filename);
    // A rebuild keeps vector providers consistent without relying on provider-specific deletes.
    return this.rebuild(clientId);
  }
  async rebuild(clientId: string) {
    const names = await this.storage.list(clientId);
    const all: { source: string; text: string }[] = [];
    for (const n of names) {
      const text = await parseDocument(n, await this.storage.read(clientId, n));
      all.push(...chunks(text).map((x) => ({ source: n, text: x })));
    }
    const e = await this.embeddings.embed(all.map((x) => x.text));
    await this.vectors.deleteTenant(clientId);
    await this.vectors.upsert(
      clientId,
      all.map((x, i) => ({
        id: crypto.createHash('sha256').update(`${clientId}\0${x.source}\0${i}\0${x.text}`).digest('hex'),
        clientId, ...x, embedding: e[i]!,
      })),
    );
    return { files: names.length, chunks: all.length };
  }
}
