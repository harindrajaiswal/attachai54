import { describe, expect, it } from 'vitest';
import { validateGrounding } from '../src/services/grounding.js';
const chunk = (text: string) => [{ id: '1', text, source: 'tenant.md', score: 0.9 }];
describe('bounded grounding validation', () => {
  it('accepts an evidence-supported qualified price', () => {
    expect(
      validateGrounding(
        'What is the price?',
        'It starts at £17.99 per month, plus a joining fee.',
        chunk('Pricing: from £17.99 per month plus joining fee; prices vary by gym.'),
      ).ok,
    ).toBe(true);
  });
  it('rejects unsupported numeric claims and explicit unknown invention', () => {
    const result = validateGrounding(
      'How much is the day pass?',
      'A day pass costs £25.',
      chunk('Day-pass pricing: UNKNOWN. The current price depends on the selected gym.'),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('unsupported numeric claim');
  });
  it('rejects an absolute answer that drops a qualification', () => {
    expect(
      validateGrounding(
        'Are all gyms open 24/7?',
        'All gyms are open 24/7.',
        chunk('Most gyms are open 24/7, but some have different hours.'),
      ).ok,
    ).toBe(false);
  });

  it('accepts practical paraphrases of explicitly supported Gousto facts', () => {
    expect(
      validateGrounding(
        'What is Gousto’s delivery fee?',
        'Gousto delivery costs 3.99.',
        chunk('Delivery is publicly listed as £3.99.'),
      ).ok,
    ).toBe(true);
    expect(
      validateGrounding(
        'How many people can a Gousto recipe box serve?',
        'A Gousto box serves one to five people.',
        chunk('Gousto boxes are designed for 1 to 5 people.'),
      ).ok,
    ).toBe(true);
    expect(
      validateGrounding(
        'How many recipes does Gousto offer each week?',
        'You can choose from over 175 recipes each week.',
        chunk('Customers can choose from over 175 recipes each week.'),
      ).ok,
    ).toBe(true);
  });

  it('does not let an unrelated tenant UNKNOWN line reject supported capacity', () => {
    expect(
      validateGrounding(
        'How many people can a Gousto recipe box serve?',
        'A Gousto recipe box can serve anywhere from 1 to 5 people.',
        chunk(
          'Gousto offers boxes for 1 to 5 people. Does Gousto provide emergency delivery? A: UNKNOWN.',
        ),
      ).ok,
    ).toBe(true);
  });

  it('does not let an unrelated negative sentence in a multi-sentence chunk reject a supported affirmative answer', () => {
    expect(
      validateGrounding(
        'Is standard delivery available and how long does it take?',
        'Standard delivery is available Monday through Saturday and takes 3 business days.',
        chunk(
          'Express delivery is not available on Sundays. Standard delivery is available Monday through Saturday and takes three business days.',
        ),
      ).ok,
    ).toBe(true);
  });

  it('still rejects a different currency for a supported pound amount', () => {
    expect(
      validateGrounding(
        'What is Gousto’s delivery fee?',
        'The delivery fee is $3.99.',
        chunk('Delivery is publicly listed as £3.99.'),
      ).ok,
    ).toBe(false);
  });
});
