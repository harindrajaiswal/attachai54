import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashKey,
  normalizeDomain,
  originMatches,
  safeSegment,
} from '../src/lib/security.js';
import { chunks } from '../src/services/parser.js';
import { LocalEmbedding } from '../src/providers/embedding.js';
import { LocalLlm } from '../src/providers/llm.js';
describe('unit', () => {
  it('generates unique prefixed keys', () => {
    expect(generateApiKey()).toMatch(/^tai_/);
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
  it('hashes keys one-way and deterministically', () => {
    expect(hashKey('a')).toBe(hashKey('a'));
    expect(hashKey('a')).toHaveLength(64);
    expect(hashKey('a')).not.toBe('a');
  });
  it('normalizes exact domains', () =>
    expect(normalizeDomain('HTTPS://Example.COM/path')).toBe('example.com'));
  it('does not allow suffix domain confusion', () =>
    expect(originMatches('https://evil-example.com', ['example.com'])).toBe(false));
  it('rejects traversal segments', () => expect(() => safeSegment('../x')).toThrow());
  it('chunks with overlap', () => {
    const x = chunks('a'.repeat(2000), 900, 100);
    expect(x).toHaveLength(3);
    expect(x[0]).toHaveLength(900);
  });
  it('local embeddings are deterministic', async () => {
    const p = new LocalEmbedding();
    expect(await p.embed(['hello'])).toEqual(await p.embed(['hello']));
  });
  it('local LLM falls back without context', async () => {
    const p = new LocalLlm();
    expect(
      await p.answer({
        question: 'x',
        prompt: 'p',
        context: [],
        config: { assistantName: 'a', fallbackMessage: 'no' },
      }),
    ).toBe('no');
  });
});
