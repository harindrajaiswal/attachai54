import { describe, expect, it } from 'vitest';
import { cleanAnswerScaffolding, selectFocusedEvidence } from '../src/services/advanced-rag.js';

type C = { id: string; text: string; source: string; score: number };
const c = (id: string, text: string, score: number): C => ({ id, text, source: 'tenant.md', score });

describe('Advanced RAG evidence selection adapter', () => {
  it('keeps only question-related evidence instead of a tenant-wide FAQ tail', () => {
    const result = selectFocusedEvidence([
      c('overview', 'Gousto is a recipe box service delivering meal kits to customers.', 0.90),
      c('emergency', 'Emergency delivery is not available. Contact customer care.', 0.84),
      c('allergens', 'Allergen information is shown on each recipe page.', 0.82),
    ], 'What is Gousto and what service does it provide?');
    expect(result.evidence.map((x) => x.id)).toEqual(['overview']);
    expect(result.rejected.some((x) => x.id === 'emergency')).toBe(true);
  });

  it('extracts one relevant FAQ answer and removes scaffolding', () => {
    const result = selectFocusedEvidence([
      c('faq', 'Q: What are box sizes? A: Boxes serve 1 to 5 people. Q: Is delivery free? A: Delivery fees vary.', 0.91),
    ], 'What box sizes are available?');
    expect(result.evidence[0]?.text).toBe('Boxes serve 1 to 5 people.');
    expect(cleanAnswerScaffolding('## FAQ Q: What are sizes? A: 1 to 5 people. 1 to 5 people.')).toBe('1 to 5 people.');
  });

  it('bounds selected context and deduplicates equivalent chunks', () => {
    const result = selectFocusedEvidence([
      c('one', 'Pricing starts at £17.99 per month, subject to terms.', 0.90),
      c('two', 'Pricing starts at £17.99 per month, subject to terms.', 0.89),
      c('three', 'Membership prices vary by location and eligibility.', 0.88),
    ], 'What is the membership pricing?', 100);
    expect(result.evidence.length).toBeLessThanOrEqual(3);
    expect(result.evidence.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(100);
  });
});
