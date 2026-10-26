/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/services/chat.js';

const evidence = { id: 'care', text: 'Call 020 3011 1002 or use the Help Centre.', source: 'knowledge.md', score: 0.9 };
const client: any = { id: 'tenant-a', enabled: true, name: 'Tenant A', slug: 'tenant-a', prompt: 'Be concise.', createdAt: '', updatedAt: '', config: { assistantName: 'A', companyName: 'Tenant A', fallbackMessage: 'UNKNOWN', topK: 4 } };
function fixture(first: string, second = first) {
  let calls = 0;
  const repo: any = { getClient: vi.fn(async () => client), createConversation: vi.fn(async () => 'conversation-1'), messages: vi.fn(async () => []), addMessage: vi.fn(async () => undefined), usage: vi.fn(async () => undefined) };
  const vector: any = { search: vi.fn(async () => [evidence]) };
  const llm: any = { answer: vi.fn(async () => ++calls === 1 ? first : second), streamAnswer: vi.fn(async (_input: any, onToken: (x: string) => void) => { onToken(first); return first; }) };
  return { service: new ChatService(repo, { embed: vi.fn(async () => [[1]]) } as any, vector, llm) };
}
describe('runtime grounding integration', () => {
  it('returns a supported first answer without correction', async () => {
    const { service } = fixture(evidence.text);
    const result = await service.chat('tenant-a', 'How can I contact Customer Care?');
    expect(result.answer).toBe(evidence.text);
  });
  it('corrects one unsupported first answer and returns the grounded correction', async () => {
    const { service } = fixture('Call £25.', evidence.text);
    const result = await service.chat('tenant-a', 'How can I contact Customer Care?');
    expect(result.answer).toBe(evidence.text);
  });
  it('uses the safe fallback when the bounded correction also fails', async () => {
    const { service } = fixture('Call £25.');
    const result = await service.chat('tenant-a', 'How can I contact Customer Care?');
    expect(result.answer).toBe('UNKNOWN');
  });
  it('does not emit invalid stream tokens before correction', async () => {
    const { service } = fixture('Call £25.', evidence.text);
    const output: string[] = [];
    const result = await service.stream('tenant-a', 'How can I contact Customer Care?', undefined, (token) => output.push(token));
    expect(output.join('')).toBe('UNKNOWN');
    expect(result.answer).toBe('UNKNOWN');
  });
  it('applies grounding to preview', async () => {
    const { service } = fixture('Call £25.', evidence.text);
    const result = await service.preview('tenant-a', 'How can I contact Customer Care?', 'Be concise.');
    expect(result.answer).toBe(evidence.text);
  });
});
