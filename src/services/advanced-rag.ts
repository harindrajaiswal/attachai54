import type { RetrievedChunk } from '../domain/types.js';

export type EvidenceStatus = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNCERTAIN' | 'NOT_SUPPORTED';
export type EvidenceDecision = {
  status: EvidenceStatus;
  coverage: number;
  count: number;
  sources: number;
  sufficient: boolean;
};
export type StageTimings = {
  classificationMs: number;
  dbReadMs: number;
  embeddingMs: number;
  initialRetrievalMs: number;
  reformulationMs: number;
  additionalRetrievalMs: number;
  rerankAndContextMs: number;
  llmFirstTokenMs: number;
  llmCompleteMs: number;
  groundingMs: number;
  correctionMs: number;
  dbWriteMs: number;
  totalMs: number;
  llmCalls: number;
  embeddingCalls: number;
  retrievalRounds: number;
};
export type RetrievalDiagnostics = {
  query: string;
  expanded: boolean;
  profile: { documents: number; chunks: number; vocabulary: number; topTerms: string[] };
  candidateCounts: { exact: number; keyword: number; bm25: number; dense: number; fused: number };
  evidence: EvidenceDecision;
  rejected: Array<{ id: string; reason: string }>;
  timings?: StageTimings;
};
export type AdvancedRetrieval = {
  evidence: RetrievedChunk[];
  decision: EvidenceDecision;
  diagnostics: RetrievalDiagnostics;
};

export type QueryIntent =
  | 'greeting'
  | 'closing'
  | 'identity'
  | 'summary'
  | 'follow_up'
  | 'ambiguous'
  | 'general'
  | 'knowledge';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'what',
  'which',
  'who',
  'how',
  'much',
  'does',
  'do',
  'did',
  'of',
  'for',
  'to',
  'in',
  'on',
  'and',
  'or',
  'will',
  'can',
  'i',
  'my',
  'it',
  'this',
  'that',
  'with',
  'when',
  'where',
  'why',
  'about',
]);
const SYNONYMS: Record<string, string> = {
  cancellation: 'cancel',
  canceled: 'cancel',
  cancelled: 'cancel',
  receive: 'refund',
  received: 'refund',
  back: 'refund',
  money: 'refund',
  flat: 'property',
  homes: 'property',
  home: 'property',
  monthly: 'month',
  price: 'cost',
  pricing: 'cost',
};
const MAX_CANDIDATES = 40;
const RETRIEVAL_K = 20;
const FINAL_K = 6;
const CONTEXT_CHARS = 5000;

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (
    word.length > 4 &&
    word.endsWith('es') &&
    !word.endsWith('ses') &&
    !word.endsWith('xes') &&
    !word.endsWith('zes')
  ) {
    return word.slice(0, -1);
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

const tokenCache = new Map<string, string[]>();

export const tokens = (value: string): string[] => {
  const cached = tokenCache.get(value);
  if (cached) return cached;
  const computed = (value.toLowerCase().match(/[\p{L}\p{N}_/-]+/gu) ?? [])
    .map((token) => SYNONYMS[token] ?? stem(token))
    .map((token) => SYNONYMS[token] ?? token)
    .filter((token) => !STOPWORDS.has(token));
  if (tokenCache.size > 2000) tokenCache.clear();
  tokenCache.set(value, computed);
  return computed;
};

const overlap = (query: Set<string>, text: string) => {
  const docTokens = new Set(tokens(text));
  let count = 0;
  for (const token of query) {
    if (docTokens.has(token)) count += 1;
  }
  return count;
};
const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const byScore = (items: Array<{ chunk: RetrievedChunk; score: number }>) =>
  items.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));

export function classifyQueryIntent(
  question: string,
  history: { role: string; content: string }[] = [],
): QueryIntent {
  const q = question.trim();
  const lower = q.toLowerCase();
  if (
    /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|greetings|howdy|yo)(?:[\s!.,?]*|(?:[\s,!]+(?:there|team|assistant|ai|everyone))[\s!.,?]*)$/i.test(
      q,
    )
  ) {
    return 'greeting';
  }
  if (
    /^(?:thanks|thank\s+you|thx|ty|many\s+thanks|thanks\s+a\s+lot|appreciate\s+it|bye|goodbye|see\s+you|have\s+a\s+good\s+day|that(?:'s|\s+is)\s+all)(?:[\s!.,?]*)$/i.test(
      q,
    )
  ) {
    return 'closing';
  }
  if (
    /\b(?:summari[sz]e|summary|recap)\b/i.test(q) &&
    /\b(?:chat|conversation|discussion|messages|thread|far|above|discussed|talked)\b/i.test(q)
  ) {
    return 'summary';
  }
  if (
    /\b(?:who\s+are\s+you|what\s+is\s+your\s+name|your\s+role|what\s+company\s+do\s+you\s+work\s+for|which\s+company\s+are\s+you)\b/i.test(
      q,
    )
  ) {
    return 'identity';
  }
  const hasPronoun =
    /\b(?:it|its|that|this|they|them|their|those|these|there|he|she|him|her)\b/i.test(lower);
  const startsAsContinuation = /^(?:and|also|what\s+about|how\s+about|what\s+if)\b/i.test(lower);
  const toks = tokens(q);
  if (history.length > 0 && (hasPronoun || startsAsContinuation || toks.length <= 3)) {
    return 'follow_up';
  }
  if (
    history.length === 0 &&
    toks.length <= 1 &&
    (hasPronoun ||
      /^(?:help|info|information|details|more|tell\s+me\s+more|what\s+about\s+it|how\s+much\s+is\s+it|how\s+does\s+it\s+work)[?.!]*$/i.test(
        q,
      ))
  ) {
    return 'ambiguous';
  }
  const tenantCues =
    /\b(your|our|company|service|services|policy|pricing|price|cost|hours|contact|support|refund|plan|plans|product|products|location|locations|delivery|membership|gym|box|recipe|recipes|task|tasker|airtasker|gousto|account|booking|order|cancel|dispute|fee|fees)\b/i.test(
      q,
    );
  const generalPatterns =
    /^(what\s+is\s+\d+\s*[\d+\-*/]+\s*\d+|what\s+is\s+the\s+capital\s+of\b|define\s+\w+|translate\b|explain\s+photosynthesis\b)/i.test(
      q,
    );
  if (!tenantCues && generalPatterns) {
    return 'general';
  }
  return 'knowledge';
}

export function buildAlternativeQueries(question: string): string[] {
  const q = question.trim();
  const alts: string[] = [];
  const stripped = q
    .replace(
      /^(?:can\s+you\s+(?:please\s+)?(?:tell\s+me|explain|help\s+me\s+with)|could\s+you\s+(?:please\s+)?(?:tell\s+me|explain)|i\s+(?:would\s+like|want)\s+to\s+know|please\s+(?:tell\s+me|explain)|do\s+you\s+know)\s+/i,
      '',
    )
    .trim();
  if (stripped && stripped.toLowerCase() !== q.toLowerCase()) {
    alts.push(stripped);
  }
  const keywordOnly = tokens(q).join(' ');
  if (keywordOnly && keywordOnly.toLowerCase() !== q.toLowerCase() && !alts.includes(keywordOnly)) {
    alts.push(keywordOnly);
  }
  const subParts = q
    .split(/\b(?:and\s+also|and\s+(?=(?:what|how|when|where|who|can|do|does|is|are)\b)|;|\?)\s*/i)
    .map((s) => s.trim())
    .filter((s) => tokens(s).length >= 2);
  if (subParts.length > 1) {
    for (const part of subParts.slice(0, 2)) {
      if (!alts.includes(part)) alts.push(part);
    }
  }
  return alts.slice(0, 3);
}

export function exactSearch(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const normalized = comparable(query);
  const queryTerms = new Set(tokens(query));
  const phrases = chunks.filter(
    (chunk) => normalized.length > 0 && comparable(chunk.text).includes(normalized),
  );
  const phraseIds = new Set(phrases.map((chunk) => chunk.id));
  const rest = byScore(
    chunks
      .filter((chunk) => !phraseIds.has(chunk.id) && overlap(queryTerms, chunk.text) > 0)
      .map((chunk) => ({ chunk, score: overlap(queryTerms, chunk.text) })),
  ).map((x) => x.chunk);
  return [...phrases, ...rest].slice(0, limit);
}

export function keywordSearch(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const queryTerms = new Set(tokens(query));
  return byScore(
    chunks
      .map((chunk) => {
        const hits = overlap(queryTerms, chunk.text);
        return { chunk, hits, score: hits + chunk.text.length / 1_000_000 };
      })
      .filter((x) => x.hits > 0),
  )
    .map((x) => x.chunk)
    .slice(0, limit);
}

export function bm25Search(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const terms = tokens(query);
  const docs = chunks.map((chunk) => tokens(chunk.text));
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const doc of docs)
    for (const term of new Set(doc))
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return byScore(
    chunks
      .map((chunk, index) => {
        const doc = docs[index]!;
        const frequency = new Map<string, number>();
        for (const term of doc) frequency.set(term, (frequency.get(term) ?? 0) + 1);
        const score = terms.reduce((sum, term) => {
          const tf = frequency.get(term) ?? 0;
          if (!tf) return sum;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          return (
            sum +
            (idf * tf * 2) / (tf + 1.5 * (0.25 + (0.75 * doc.length) / Math.max(averageLength, 1)))
          );
        }, 0);
        return { chunk, score };
      })
      .filter((x) => x.score > 0),
  )
    .map((x) => x.chunk)
    .slice(0, limit);
}

export function evaluateEvidence(query: string, chunks: RetrievedChunk[]): EvidenceDecision {
  const queryTerms = new Set(tokens(query));
  const coverage = Math.max(
    0,
    ...chunks.map((chunk) => overlap(queryTerms, chunk.text) / Math.max(1, queryTerms.size)),
  );
  const exact = chunks.some((chunk) => comparable(chunk.text).includes(comparable(query)));
  const strong = chunks.filter((chunk) => chunk.score >= 0.2).length;
  const highDense = chunks.some((chunk) => chunk.score >= 0.5);
  const isMultiPart =
    /\b(?:and|also)\s+(?:what|how|when|where|who|can|do|does|is|are)\b/i.test(query) ||
    (query.match(/\?/g)?.length ?? 0) > 1;
  const multiPartPartial = isMultiPart && !exact && coverage >= 0.2 && coverage < 0.65;
  const status: EvidenceStatus = multiPartPartial
    ? 'PARTIALLY_SUPPORTED'
    : exact || coverage >= 0.55 || strong >= 2 || highDense
      ? 'SUPPORTED'
      : (coverage >= 0.2 || strong >= 1) && chunks.length
        ? 'PARTIALLY_SUPPORTED'
        : coverage > 0 && chunks.length
          ? 'UNCERTAIN'
          : 'NOT_SUPPORTED';
  return {
    status,
    coverage,
    count: chunks.length,
    sources: new Set(chunks.map((chunk) => chunk.source)).size,
    sufficient: status === 'SUPPORTED' || status === 'PARTIALLY_SUPPORTED',
  };
}

function profile(chunks: RetrievedChunk[]) {
  const frequencies = new Map<string, number>();
  for (const chunk of chunks)
    for (const term of tokens(chunk.text).filter((term) => term.length > 2))
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return {
    documents: new Set(chunks.map((chunk) => chunk.source)).size,
    chunks: chunks.length,
    vocabulary: frequencies.size,
    topTerms: [...frequencies.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([term]) => term),
  };
}

function rrf(rankings: RetrievedChunk[][], limit = MAX_CANDIDATES) {
  const scores = new Map<string, number>();
  const found = new Map<string, RetrievedChunk>();
  for (const ranking of rankings)
    ranking.forEach((chunk, rank) => {
      const prev = found.get(chunk.id);
      if (!prev || chunk.score > prev.score) found.set(chunk.id, chunk);
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (60 + rank + 1));
    });
  return [...found.values()]
    .map((chunk) => ({ ...chunk, score: scores.get(chunk.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function rerank(
  query: string,
  chunks: RetrievedChunk[],
  vocabulary: string[],
  denseScores?: ReadonlyMap<string, number>,
) {
  const queryTerms = new Set(tokens(query));
  const topTerms = new Set(vocabulary);
  const domain =
    [...queryTerms].filter((term) => topTerms.has(term)).length / Math.max(1, queryTerms.size);
  const scored = chunks.map((chunk) => {
    const lexHits = overlap(queryTerms, chunk.text);
    const lexical = lexHits / Math.max(1, queryTerms.size);
    const phrase = Number(comparable(chunk.text).includes(comparable(query)));
    const lexicalScore = 0.65 * lexical + 0.25 * phrase + 0.1 * domain;
    const denseScore = denseScores ? (denseScores.get(chunk.id) ?? 0) : chunk.score;
    const score = lexHits > 0 ? Math.max(lexicalScore, denseScore) : denseScore;
    return { ...chunk, score, _lexHits: lexHits };
  });
  const hasLexical = scored.some((c) => c._lexHits > 0);
  return scored
    .filter((chunk) => chunk.score > 0 && (!hasLexical || chunk._lexHits > 0))
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) <= 0.08 && b._lexHits !== a._lexHits) {
        return b._lexHits - a._lexHits;
      }
      return b.score - a.score || a.id.localeCompare(b.id);
    })
    .map(({ _lexHits, ...chunk }) => chunk);
}

function expandedQuery(query: string, chunks: RetrievedChunk[]) {
  const existing = new Set(tokens(query));
  const frequency = new Map<string, number>();
  for (const chunk of chunks)
    for (const term of tokens(chunk.text))
      if (!existing.has(term) && term.length > 2)
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const additions = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([term]) => term);
  const alt = buildAlternativeQueries(query)[0] ?? '';
  return [query, alt, additions.join(' ')].filter(Boolean).join(' ').trim();
}

function deduplicate(chunks: RetrievedChunk[]) {
  const text = new Set<string>();
  return chunks.filter((chunk) => {
    const key = comparable(chunk.text);
    if (!key || text.has(key)) return false;
    text.add(key);
    return true;
  });
}

function selectContext(chunks: RetrievedChunk[]) {
  const deduped = deduplicate(chunks);
  const topScore = deduped[0]?.score ?? 0;
  const selected: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of deduped) {
    if (selected.length >= 3 && chunk.score < topScore * 0.45) break;
    const labelLength = `[Source ${selected.length + 1}: ${chunk.source} | chunk ${chunk.id}]\n`
      .length;
    if (used + labelLength + chunk.text.length > CONTEXT_CHARS) break;
    selected.push(chunk);
    used += labelLength + chunk.text.length + 2;
  }
  return selected;
}

export async function retrieveAdvancedEvidence(input: {
  question: string;
  corpus: RetrievedChunk[];
  dense: RetrievedChunk[];
}): Promise<AdvancedRetrieval> {
  const corpus = deduplicate(input.corpus.length ? input.corpus : input.dense);
  const denseScores = new Map<string, number>();
  for (const chunk of input.dense) {
    denseScores.set(chunk.id, Math.max(denseScores.get(chunk.id) ?? 0, chunk.score));
  }
  const topTerms = profile(corpus).topTerms;
  const run = (query: string, dense: RetrievedChunk[]) => {
    const exact = exactSearch(query, corpus);
    const keyword = keywordSearch(query, corpus);
    const bm25 = bm25Search(query, corpus);
    const fused = rrf([exact, keyword, bm25, dense.slice(0, RETRIEVAL_K)]);
    return {
      exact,
      keyword,
      bm25,
      fused,
      ranked: rerank(query, fused, topTerms, denseScores).slice(0, FINAL_K),
    };
  };
  const first = run(input.question, input.dense);
  let selected = selectContext(first.ranked);
  let decision = evaluateEvidence(input.question, selected);
  let expanded = false;
  let candidateCounts = {
    exact: first.exact.length,
    keyword: first.keyword.length,
    bm25: first.bm25.length,
    dense: input.dense.length,
    fused: first.fused.length,
  };
  if ((decision.status === 'UNCERTAIN' || decision.status === 'NOT_SUPPORTED') && corpus.length) {
    expanded = true;
    const query = expandedQuery(input.question, corpus);
    const second = run(query, input.dense);
    selected = selectContext(
      rerank(
        input.question,
        rrf([first.fused, second.keyword, second.bm25, input.dense.slice(0, RETRIEVAL_K)]),
        topTerms,
        denseScores,
      ).slice(0, FINAL_K),
    );
    decision = evaluateEvidence(input.question, selected);
    candidateCounts = {
      exact: first.exact.length + second.exact.length,
      keyword: first.keyword.length + second.keyword.length,
      bm25: first.bm25.length + second.bm25.length,
      dense: input.dense.length,
      fused: Math.min(MAX_CANDIDATES, first.fused.length + second.fused.length),
    };
  }
  const rejected = selected
    .filter((chunk) => chunk.score < 0.2)
    .map((chunk) => ({ id: chunk.id, reason: 'low deterministic rerank score' }));
  return {
    evidence: selected,
    decision,
    diagnostics: {
      query: input.question,
      expanded,
      profile: profile(corpus),
      candidateCounts,
      evidence: decision,
      rejected,
    },
  };
}

/** Source-labelled, bounded whole-chunk context from the standalone baseline. */
export function buildEvidenceContext(chunks: RetrievedChunk[]) {
  return chunks
    .map((chunk, index) => `[Source ${index + 1}: ${chunk.source} | chunk ${chunk.id}]\n${chunk.text}`)
    .join('\n\n');
}

export function cleanAnswerScaffolding(answer: string) {
  const cleaned = answer
    .replace(/\\n/g, '\n')
    .replace(/\[Source\s+\d+:[^\]]*\]/gi, ' ')
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:faq|answer)\s*:?\s*/gi, ' ')
    .replace(/(?:^|\s)Q:\s*[^?\n]+\?\s*A:\s*/gi, ' ')
    .replace(/(?:^|\n|\s)[QA]:\s*/gi, ' ')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = cleaned.split(/(?<!\b\d+)(?<!\b[a-zA-Z])(?<=[.!?])\s+/).filter(Boolean);
  const seen = new Set<string>();
  return sentences
    .filter((sentence) => {
      const key = comparable(sentence);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ')
    .trim();
}

// Compatibility alias retained for existing focused unit consumers. The active path uses retrieveAdvancedEvidence.
export function selectFocusedEvidence(
  candidates: RetrievedChunk[],
  question: string,
  maxChars = CONTEXT_CHARS,
) {
  const denseScores = new Map<string, number>();
  for (const c of candidates) {
    denseScores.set(c.id, Math.max(denseScores.get(c.id) ?? 0, c.score));
  }
  const ranked = rerank(
    question,
    rrf([
      exactSearch(question, candidates),
      keywordSearch(question, candidates),
      bm25Search(question, candidates),
      candidates,
    ]),
    profile(candidates).topTerms,
    denseScores,
  );
  const evidence: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of deduplicate(ranked)) {
    const qaPairs = [
      ...chunk.text.matchAll(/(?:Q:\s*([^?]+\?)\s*)?A:\s*(.*?)(?=\s*Q:|$)/gi),
    ];
    let candidate = chunk.text;
    if (qaPairs.length > 0) {
      const qSet = new Set(tokens(question));
      const bestQa = qaPairs
        .map((m) => ({
          answer: m[2]?.trim() ?? '',
          hits: overlap(qSet, `${m[1] ?? ''} ${m[2] ?? ''}`),
        }))
        .sort((a, b) => b.hits - a.hits)[0];
      if (bestQa?.answer) candidate = bestQa.answer;
    }
    if (used + candidate.length > maxChars) continue;
    evidence.push({ ...chunk, text: candidate });
    used += candidate.length;
    if (evidence.length >= 3) break;
  }
  return {
    evidence,
    rejected: candidates
      .filter((chunk) => !evidence.some((selected) => selected.id === chunk.id))
      .map((chunk) => ({ id: chunk.id, reason: 'not selected by bounded evidence selection' })),
  };
}
