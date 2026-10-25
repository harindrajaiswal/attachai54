import type { RetrievedChunk } from '../domain/types.js';

export type EvidenceStatus = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNCERTAIN' | 'NOT_SUPPORTED';
export type EvidenceDecision = {
  status: EvidenceStatus;
  coverage: number;
  count: number;
  sources: number;
  sufficient: boolean;
};
export type RetrievalDiagnostics = {
  query: string;
  expanded: boolean;
  profile: { documents: number; chunks: number; vocabulary: number; topTerms: string[] };
  candidateCounts: { exact: number; keyword: number; bm25: number; dense: number; fused: number };
  evidence: EvidenceDecision;
  rejected: Array<{ id: string; reason: string }>;
};
export type AdvancedRetrieval = {
  evidence: RetrievedChunk[];
  decision: EvidenceDecision;
  diagnostics: RetrievalDiagnostics;
};

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'how', 'much', 'does', 'do', 'did', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'will', 'can', 'i', 'my', 'it', 'this', 'that', 'with', 'when', 'where', 'why']);
const SYNONYMS: Record<string, string> = { cancellation: 'cancel', canceled: 'cancel', cancelled: 'cancel', receive: 'refund', received: 'refund', back: 'refund', money: 'refund', flat: 'property', homes: 'property', home: 'property' };
const MAX_CANDIDATES = 40;
const RETRIEVAL_K = 20;
const FINAL_K = 8;
const CONTEXT_CHARS = 7000;

export const tokens = (value: string) =>
  (value.toLowerCase().match(/[\p{L}\p{N}_/-]+/gu) ?? [])
    .map((token) => SYNONYMS[token] ?? token)
    .filter((token) => !STOPWORDS.has(token));
const overlap = (query: Set<string>, text: string) => [...query].filter((token) => tokens(text).includes(token)).length;
const comparable = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
const byScore = (items: Array<{ chunk: RetrievedChunk; score: number }>) =>
  items.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));

export function exactSearch(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const normalized = comparable(query);
  const queryTerms = new Set(tokens(query));
  const phrases = chunks.filter((chunk) => normalized.length > 0 && comparable(chunk.text).includes(normalized));
  const phraseIds = new Set(phrases.map((chunk) => chunk.id));
  const rest = byScore(chunks.filter((chunk) => !phraseIds.has(chunk.id) && overlap(queryTerms, chunk.text) > 0).map((chunk) => ({ chunk, score: overlap(queryTerms, chunk.text) }))).map((x) => x.chunk);
  return [...phrases, ...rest].slice(0, limit);
}

export function keywordSearch(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const queryTerms = new Set(tokens(query));
  return byScore(chunks.map((chunk) => ({ chunk, score: overlap(queryTerms, chunk.text) + chunk.text.length / 1_000_000 }))).map((x) => x.chunk).slice(0, limit);
}

export function bm25Search(query: string, chunks: RetrievedChunk[], limit = RETRIEVAL_K) {
  const terms = tokens(query);
  const docs = chunks.map((chunk) => tokens(chunk.text));
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return byScore(chunks.map((chunk, index) => {
    const doc = docs[index]!;
    const frequency = new Map<string, number>();
    for (const term of doc) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const score = terms.reduce((sum, term) => {
      const tf = frequency.get(term) ?? 0;
      if (!tf) return sum;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      return sum + idf * tf * 2 / (tf + 1.5 * (0.25 + 0.75 * doc.length / Math.max(averageLength, 1)));
    }, 0);
    return { chunk, score };
  })).map((x) => x.chunk).slice(0, limit);
}

export function evaluateEvidence(query: string, chunks: RetrievedChunk[]): EvidenceDecision {
  const queryTerms = new Set(tokens(query));
  const coverage = Math.max(0, ...chunks.map((chunk) => overlap(queryTerms, chunk.text) / Math.max(1, queryTerms.size)));
  const exact = chunks.some((chunk) => comparable(chunk.text).includes(comparable(query)));
  const strong = chunks.filter((chunk) => chunk.score >= 0.2).length;
  const status: EvidenceStatus = exact || coverage >= 0.55 || strong >= 2
    ? 'SUPPORTED'
    : coverage >= 0.2 && chunks.length
      ? 'PARTIALLY_SUPPORTED'
      : coverage > 0 && chunks.length ? 'UNCERTAIN' : 'NOT_SUPPORTED';
  return { status, coverage, count: chunks.length, sources: new Set(chunks.map((chunk) => chunk.source)).size, sufficient: status === 'SUPPORTED' || status === 'PARTIALLY_SUPPORTED' };
}

function profile(chunks: RetrievedChunk[]) {
  const frequencies = new Map<string, number>();
  for (const chunk of chunks) for (const term of tokens(chunk.text).filter((term) => term.length > 2)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return { documents: new Set(chunks.map((chunk) => chunk.source)).size, chunks: chunks.length, vocabulary: frequencies.size, topTerms: [...frequencies.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([term]) => term) };
}

function rrf(rankings: RetrievedChunk[][], limit = MAX_CANDIDATES) {
  const scores = new Map<string, number>();
  const found = new Map<string, RetrievedChunk>();
  for (const ranking of rankings) ranking.forEach((chunk, rank) => {
    found.set(chunk.id, chunk);
    scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (60 + rank + 1));
  });
  return [...found.values()].map((chunk) => ({ ...chunk, score: scores.get(chunk.id) ?? 0 })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function rerank(query: string, chunks: RetrievedChunk[], vocabulary: string[]) {
  const queryTerms = new Set(tokens(query));
  const topTerms = new Set(vocabulary);
  const domain = [...queryTerms].filter((term) => topTerms.has(term)).length / Math.max(1, queryTerms.size);
  return chunks.map((chunk) => {
    const lexical = overlap(queryTerms, chunk.text) / Math.max(1, queryTerms.size);
    const phrase = Number(comparable(chunk.text).includes(comparable(query)));
    return { ...chunk, score: 0.65 * lexical + 0.25 * phrase + 0.1 * domain };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function expandedQuery(query: string, chunks: RetrievedChunk[]) {
  const existing = new Set(tokens(query));
  const frequency = new Map<string, number>();
  for (const chunk of chunks) for (const term of tokens(chunk.text)) if (!existing.has(term) && term.length > 2) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const additions = [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([term]) => term);
  return additions.length ? `${query} ${additions.join(' ')}` : query;
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
  const selected: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of deduplicate(chunks)) {
    const labelLength = `[Source ${selected.length + 1}: ${chunk.source} | chunk ${chunk.id}]\n`.length;
    if (used + labelLength + chunk.text.length > CONTEXT_CHARS) break;
    selected.push(chunk);
    used += labelLength + chunk.text.length + 2;
  }
  return selected;
}

export async function retrieveAdvancedEvidence(input: { question: string; corpus: RetrievedChunk[]; dense: RetrievedChunk[] }): Promise<AdvancedRetrieval> {
  const corpus = deduplicate(input.corpus);
  const run = (query: string, dense: RetrievedChunk[]) => {
    const exact = exactSearch(query, corpus);
    const keyword = keywordSearch(query, corpus);
    const bm25 = bm25Search(query, corpus);
    const fused = rrf([exact, keyword, bm25, dense.slice(0, RETRIEVAL_K)]);
    return { exact, keyword, bm25, fused, ranked: rerank(input.question, fused, profile(corpus).topTerms).slice(0, FINAL_K) };
  };
  const first = run(input.question, input.dense);
  let selected = selectContext(first.ranked);
  let decision = evaluateEvidence(input.question, selected);
  let expanded = false;
  let candidateCounts = { exact: first.exact.length, keyword: first.keyword.length, bm25: first.bm25.length, dense: input.dense.length, fused: first.fused.length };
  if ((decision.status === 'UNCERTAIN' || decision.status === 'NOT_SUPPORTED') && corpus.length) {
    expanded = true;
    const query = expandedQuery(input.question, corpus);
    const second = run(query, []);
    selected = selectContext(rerank(input.question, rrf([first.fused, second.keyword, second.bm25]), profile(corpus).topTerms).slice(0, FINAL_K));
    decision = evaluateEvidence(input.question, selected);
    candidateCounts = { exact: first.exact.length + second.exact.length, keyword: first.keyword.length + second.keyword.length, bm25: first.bm25.length + second.bm25.length, dense: input.dense.length, fused: Math.min(MAX_CANDIDATES, first.fused.length + second.fused.length) };
  }
  const rejected = selected.filter((chunk) => chunk.score < 0.2).map((chunk) => ({ id: chunk.id, reason: 'low deterministic rerank score' }));
  return { evidence: selected, decision, diagnostics: { query: input.question, expanded, profile: profile(corpus), candidateCounts, evidence: decision, rejected } };
}

/** Source-labelled, bounded whole-chunk context from the standalone baseline. */
export function buildEvidenceContext(chunks: RetrievedChunk[]) {
  return chunks.map((chunk, index) => `[Source ${index + 1}: ${chunk.source} | chunk ${chunk.id}]\n${chunk.text}`).join('\n\n');
}

export function cleanAnswerScaffolding(answer: string) {
  const cleaned = answer.replace(/^\s*(?:#{1,6}\s*)?(?:faq|answer)\s*:?\s*/i, '').replace(/(?:^|\n)\s*[QA]:\s*/gi, ' ').replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/\s+/g, ' ').trim();
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  const seen = new Set<string>();
  return sentences.filter((sentence) => { const key = comparable(sentence); if (!key || seen.has(key)) return false; seen.add(key); return true; }).join(' ').trim();
}

// Compatibility alias retained for existing focused unit consumers. The active path uses retrieveAdvancedEvidence.
export function selectFocusedEvidence(candidates: RetrievedChunk[], question: string, maxChars = CONTEXT_CHARS) {
  const ranked = rerank(question, rrf([exactSearch(question, candidates), keywordSearch(question, candidates), bm25Search(question, candidates), candidates]), profile(candidates).topTerms);
  const evidence: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of deduplicate(ranked)) {
    const faq = chunk.text.match(/(?:Q:\s*[^?]+\?\s*)?A:\s*(.*?)(?=\s*Q:|$)/i)?.[1]?.trim();
    const candidate = faq || chunk.text;
    if (used + candidate.length > maxChars) continue;
    evidence.push({ ...chunk, text: candidate });
    used += candidate.length;
    if (evidence.length >= 3) break;
  }
  return { evidence, rejected: candidates.filter((chunk) => !evidence.some((selected) => selected.id === chunk.id)).map((chunk) => ({ id: chunk.id, reason: 'not selected by bounded evidence selection' })) };
}
