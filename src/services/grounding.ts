import type { RetrievedChunk } from '../domain/types.js';

export type GroundingCheck = { ok: boolean; reasons: string[] };

type NumericClaim = { key: string; value: string; currency: string; qualifier: string };

const WORD_NUMBERS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  fourteen: '14',
  fifteen: '15',
  twenty: '20',
  twentyfour: '24',
  thirty: '30',
  forty: '40',
  fifty: '50',
  hundred: '100',
};

/**
 * Remove structural list/step numbering and source citation tags before
 * extracting factual numeric claims so numbered steps (e.g. "1. Create an
 * account 2. Post a task") are not mistaken for unsupported numbers.
 */
function stripFormattingNumbers(text: string): string {
  return text
    .replace(/\[Source\s+\d+[^\]]*\]/gi, ' ')
    .replace(/\(Source\s+\d+[^)]*\)/gi, ' ')
    .replace(/\b(?:step|item|part|section|point)\s+\d+\b/gi, ' ')
    .replace(/(?:^|\n|\s)\d{1,2}[.)]\s+(?=[A-Z*“"'`])/g, ' ');
}

/**
 * Normalize numeric claims for practical grounding. Currency is retained so a
 * supported pound amount cannot silently become an unsupported dollar amount;
 * omitted currency and harmless spacing/unit wording remain compatible.
 */
const numberTokens = (text: string, stripListMarkers = false): NumericClaim[] => {
  const cleaned = stripListMarkers
    ? stripFormattingNumbers(text)
    : text.replace(/\[Source\s+\d+[^\]]*\]/gi, ' ');
  return [
    ...cleaned.matchAll(
      /(£|AUD\s*\$|\$|€|₹)?\s*(\d+(?:[.,]\d+)?)(?:\s*%|\s*(?:per|a)\s*(?:month|year|day|week))?/gi,
    ),
  ].map((match) => {
    const raw = match[0].toLowerCase();
    const currency = (match[1] ?? '').replace(/\s+/g, '').toLowerCase();
    const value = match[2]!.replace(/,/g, '');
    const qualifier = /%/.test(raw)
      ? '%'
      : (/\b(?:per|a)\s*(month|year|day|week)\b/i.exec(raw)?.[1]?.toLowerCase() ?? '');
    return { key: `${currency}:${value}:${qualifier}`, value, currency, qualifier };
  });
};

const sourceNumberTokens = (text: string): NumericClaim[] => {
  const claims = numberTokens(text, false);
  for (const [word, digit] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      claims.push({ key: `:${digit}:`, value: digit, currency: '', qualifier: '' });
    }
  }
  if (/\b(?:free|no\s+cost|zero\s+cost)\b/i.test(text)) {
    claims.push({ key: ':0:', value: '0', currency: '', qualifier: '' });
  }
  return claims;
};

const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (x) =>
        ![
          'what',
          'does',
          'have',
          'with',
          'from',
          'that',
          'this',
          'about',
          'are',
          'the',
          'and',
          'for',
          'you',
          'your',
          'can',
          'how',
          'who',
          'when',
          'where',
          'why',
        ].includes(x),
    ),
  );

function overlap(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Conservative, evidence-based checks for the most dangerous grounding failures.
 * It deliberately avoids trying to judge prose style or paraphrase quality.
 */
export function validateGrounding(
  question: string,
  answer: string,
  evidence: RetrievedChunk[],
): GroundingCheck {
  if (!evidence.length) return { ok: true, reasons: [] };
  const source = evidence.map((x) => x.text).join('\n');
  const reasons: string[] = [];
  const answerNumbers = numberTokens(answer, true);
  const sourceNumbers = sourceNumberTokens(source);
  const unsupported = answerNumbers.filter(
    (claim) =>
      !sourceNumbers.some(
        (supported) =>
          supported.value === claim.value &&
          (!claim.currency || !supported.currency || supported.currency === claim.currency) &&
          (!claim.qualifier || !supported.qualifier || supported.qualifier === claim.qualifier),
      ),
  );
  if (unsupported.length) reasons.push('unsupported numeric claim');

  const qWords = words(question);
  // A tenant/company name alone is not evidence that an UNKNOWN statement is
  // about the requested fact. Require two topical terms, excluding the
  // repeated brand token, to avoid unrelated UNKNOWN entries poisoning valid
  // answers from the same tenant document.
  const topicalQuestionWords = new Set(
    [...qWords].filter((word) => !/^(?:gousto|airtasker|available)$/i.test(word)),
  );
  const lines = source
    .split(/(?<!\b\d+)(?<!\b[a-zA-Z])(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const isUnknownLine = (x: string) =>
    /\bunknown\b|not available|not specified|cannot be verified/i.test(x);
  const unknownLines = lines.filter(isUnknownLine);
  const knownLines = lines.filter((x) => !isUnknownLine(x));
  const maxUnknownOverlap = Math.max(
    0,
    ...unknownLines.map((line) => overlap(topicalQuestionWords, words(line))),
  );
  const maxKnownOverlap = Math.max(
    0,
    ...knownLines.map((line) => overlap(topicalQuestionWords, words(line))),
  );
  if (
    maxUnknownOverlap >= 2 &&
    maxUnknownOverlap >= maxKnownOverlap &&
    answerNumbers.length &&
    !/\b(unknown|not available|not specified|cannot verify|check the official|support)\b/i.test(
      answer,
    )
  ) {
    reasons.push('answer supplies a value where relevant evidence is unknown');
  }

  const isNegative = (x: string) =>
    /\b(no|not|does not|do not|never|cannot|must not|without)\b/i.test(x);
  const negativeLines = lines.filter(isNegative);
  const positiveLines = lines.filter((x) => !isNegative(x));
  const qualifiedLines = lines.filter((x) =>
    /\b(most|some|vary|varies|depends|subject to|can differ)\b/i.test(x),
  );
  const affirmative =
    /\b(is|are|does|do|offers?|provides?|guarantees?|available|included|open|free)\b/i.test(
      answer,
    ) && !/\b(not|no|cannot|unavailable|unknown|should not|doesn['’]t|isn['’]t)\b/i.test(answer);
  const maxNegOverlap = Math.max(0, ...negativeLines.map((line) => overlap(qWords, words(line))));
  const maxPosOverlap = Math.max(0, ...positiveLines.map((line) => overlap(qWords, words(line))));
  if (affirmative && maxNegOverlap >= 1 && maxNegOverlap > maxPosOverlap) {
    reasons.push('possible contradiction with negative evidence');
  }

  const answerSentences = answer
    .split(/(?<!\b\d+)(?<!\b[a-zA-Z])(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const absoluteSentences = answerSentences.filter(
    (s) =>
      /\b(all|every|always|never)\b/i.test(s) &&
      !/\b(most|some|vary|varies|depends|subject to|may|can differ|generally|typically)\b/i.test(s),
  );
  const dropsQualification = absoluteSentences.some((absSentence) => {
    const absWords = words(absSentence);
    return qualifiedLines.some(
      (qLine) =>
        overlap(qWords, words(qLine)) >= 1 &&
        overlap(absWords, words(qLine)) >= 2 &&
        !lines.some(
          (srcLine) =>
            /\b(all|every|always|never)\b/i.test(srcLine) && overlap(absWords, words(srcLine)) >= 2,
        ),
    );
  });
  if (dropsQualification) {
    reasons.push('answer drops an evidence qualification');
  }

  return { ok: reasons.length === 0, reasons };
}

export function groundingCorrection(reasons: string[]) {
  return `Grounding check failed (${reasons.join('; ')}). Re-read TENANT KNOWLEDGE as authoritative. Correct or remove every unsupported claim, number, price, availability statement, guarantee, or policy. Preserve source qualifications (such as most, some, varies, or depends) and avoid unverified numbers. If the requested fact is absent or marked UNKNOWN, say it is not available in the current tenant knowledge. Return only the corrected customer-facing answer.`;
}
