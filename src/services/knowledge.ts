import crypto from 'node:crypto';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { VectorProvider } from '../providers/vector.js';
import type { ObjectStorage } from '../providers/storage.js';
import { chunks, parseDocument } from './parser.js';
import type { Repository } from '../repositories/repository.js';
import { AppError } from '../lib/errors.js';

/** Deterministic UUID accepted by PostgreSQL UUID columns and Qdrant point IDs. */
function stableVectorId(value: string) {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  // Mark as a name-derived UUID (v5 bit pattern) and set the RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class KnowledgeService {
  constructor(
    private storage: ObjectStorage,
    private embeddings: EmbeddingProvider,
    private vectors: VectorProvider,
    private repo?: Repository,
  ) {}
  async upload(clientId: string, name: string, data: Buffer) {
    const text = await parseDocument(name, data);
    if (!text.trim()) throw new AppError(400, 'EMPTY_DOCUMENT', 'Document contains no text');
    await this.storage.put(clientId, name, data);
    const parts = chunks(text);
    try {
      const e = await this.embeddings.embed(parts);
      await this.vectors.replaceSource(
        clientId,
        name,
        parts.map((x, i) => ({
          // Stable UUIDs satisfy the Supabase UUID schema and Qdrant point-ID format.
          id: stableVectorId(`${clientId}\0${name}\0${i}\0${x}`),
          clientId,
          source: name,
          text: x,
          embedding: e[i]!,
        })),
      );
      await this.repo?.saveKnowledge(clientId, name, data.byteLength, parts.length, 'ready');
    } catch (error) {
      // Storage is written first. Persist failure state so a failed index is not shown as unknown.
      try {
        await this.repo?.saveKnowledge(clientId, name, data.byteLength, parts.length, 'failed');
      } catch {
        // Keep the original indexing error; metadata persistence is best-effort here.
      }
      throw error;
    }
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
    const byName = new Map((metadata ?? []).map((x) => [x.filename, x] as const));
    const names = await this.storage.list(clientId);
    return Promise.all(
      names.map(async (filename) => {
        const saved = byName.get(filename);
        if (saved) return { ...saved, bytes: saved.size, embeddingStatus: saved.status };
        const size = (await this.storage.read(clientId, filename)).byteLength;
        return {
          filename,
          size,
          bytes: size,
          chunks: 0,
          status: 'unknown',
          embeddingStatus: 'unknown',
        };
      }),
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
    const files: Array<{ filename: string; size: number; parts: string[] }> = [];
    for (const filename of names) {
      const data = await this.storage.read(clientId, filename);
      const text = await parseDocument(filename, data);
      if (!text.trim()) {
        files.push({ filename, size: data.byteLength, parts: [] });
        continue;
      }
      files.push({ filename, size: data.byteLength, parts: chunks(text) });
    }

    const all = files.flatMap((file) =>
      file.parts.map((text, chunkIndex) => ({ source: file.filename, text, chunkIndex })),
    );
    try {
      const e = all.length ? await this.embeddings.embed(all.map((x) => x.text)) : [];
      await this.vectors.deleteTenant(clientId);
      await this.vectors.upsert(
        clientId,
        all.map((x, i) => ({
          id: stableVectorId(`${clientId}\0${x.source}\0${x.chunkIndex}\0${x.text}`),
          clientId,
          source: x.source,
          text: x.text,
          embedding: e[i]!,
        })),
      );
      // Rebuild must refresh relational status too; otherwise the UI reports unknown/0 forever.
      for (const file of files) {
        await this.repo?.saveKnowledge(
          clientId,
          file.filename,
          file.size,
          file.parts.length,
          file.parts.length ? 'ready' : 'empty',
        );
      }
    } catch (error) {
      for (const file of files) {
        try {
          await this.repo?.saveKnowledge(clientId, file.filename, file.size, file.parts.length, 'failed');
        } catch {
          // Preserve the indexing failure if the status write also fails.
        }
      }
      throw error;
    }
    return { files: names.length, chunks: all.length };
  }
}
