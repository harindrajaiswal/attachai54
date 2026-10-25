import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import path from 'node:path';
import { AppError } from '../lib/errors.js';
const allowed = new Set(['.txt', '.md', '.pdf', '.docx', '.csv']);
export async function parseDocument(name: string, data: Buffer) {
  const ext = path.extname(name).toLowerCase();
  if (!allowed.has(ext)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported file type');
  if (ext === '.pdf') return (await pdf(data)).text;
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: data })).value;
  if (ext === '.csv') return data.toString('utf8').split(/\r?\n/).filter(Boolean).map((row) => row.split(',').map((cell) => cell.trim()).join(' | ')).join('\n');
  return data.toString('utf8');
}

/** Structure-aware baseline adapted from Advanced RAG's paragraph/heading packer. */
export function chunks(text: string, size = 900, overlap = 120) {
  const source = text.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  // Preserve the historical deterministic behavior for unstructured blobs.
  if (!/[\n\r]/.test(source)) {
    const clean = source.replace(/\s+/g, ' ');
    const out: string[] = [];
    for (let i = 0; i < clean.length; i += size - overlap) {
      out.push(clean.slice(i, i + size));
      if (i + size >= clean.length) break;
    }
    return out;
  }
  const blocks = source.split(/\n\s*\n+/).map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.length <= size) { pieces.push(block); continue; }
    for (let i = 0; i < block.length; i += size - overlap) {
      pieces.push(block.slice(i, i + size).trim());
      if (i + size >= block.length) break;
    }
  }
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) { current = piece; continue; }
    const combined = `${current}\n\n${piece}`;
    if (combined.length <= size) current = combined;
    else { out.push(current); current = piece; }
  }
  if (current) out.push(current);
  return out;
}
