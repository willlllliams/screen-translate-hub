// Prompt building and result parsing shared by the AI engines (spec 09 section 13,
// requirement 03 section 4.4: glossary and optional context).
import type { TranslateRequest } from './engine.ts';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  vi: 'Vietnamese',
  th: 'Thai',
};

export function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag] ?? LANGUAGE_NAMES[tag.split('-')[0]] ?? tag;
}

export const DEFAULT_SYSTEM = [
  'You are a translation engine for on-screen text captured by OCR.',
  'Translate every item into the target language faithfully and naturally.',
  'Keep numbers, code, URLs, product names and placeholders unchanged.',
  'The text may contain OCR mistakes; translate the most likely intended meaning.',
  'Reply with JSON only: {"items":[{"id":<id>,"text":"<translation>"}]} with one entry per input item, in the same order.',
].join(' ');

export function buildPrompt(req: TranslateRequest): { system: string; user: string } {
  const parts: string[] = [];
  parts.push(`Target language: ${languageName(req.target_language)} (${req.target_language}).`);
  if (req.source_language && req.source_language !== 'auto') parts.push(`Source language: ${languageName(req.source_language)}.`);
  if (req.glossary?.length) {
    parts.push('Glossary (always use these translations):');
    for (const g of req.glossary) parts.push(`- ${g.source} => ${g.target}${g.note ? ` (${g.note})` : ''}`);
  }
  if (req.context?.length) {
    parts.push('Earlier text on the same screen, for reference only (do not translate):');
    for (const c of req.context) parts.push(`> ${c}`);
  }
  const items = req.segments.map((s) => ({ id: s.paragraph_id, text: s.text }));
  parts.push(`Items:\n${JSON.stringify({ items })}`);
  const user = req.prompt_template
    ? req.prompt_template.replace('{{items}}', JSON.stringify({ items })).replace('{{target}}', languageName(req.target_language))
    : parts.join('\n');
  return { system: DEFAULT_SYSTEM, user };
}

export interface PartialItem { id: number; text: string; closed: boolean }

/** Decode the body of a JSON string literal that may be cut off in the middle. */
function decodePartialJsonString(body: string): string {
  // drop a dangling backslash or an incomplete \uXXXX escape at the end
  const trimmed = body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
  try {
    return JSON.parse(`"${trimmed}"`) as string;
  } catch {
    return trimmed;
  }
}

/**
 * Extract items from a possibly incomplete `{"items":[{"id":1,"text":"..."}, ...]}` buffer.
 * Used to turn streamed model output into cumulative per-paragraph versions.
 */
export function extractItems(buffer: string): PartialItem[] {
  const out: PartialItem[] = [];
  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
  for (let m = re.exec(buffer); m; m = re.exec(buffer)) {
    out.push({ id: Number(m[1]), text: decodePartialJsonString(m[2]), closed: m[3] === '"' });
  }
  return out;
}

/** Parse a complete reply; tolerates code fences and surrounding prose. */
export function parseItems(text: string): Map<number, string> {
  const result = new Map<number, string>();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { items?: Array<{ id: number; text: string }> };
      for (const it of obj.items ?? []) if (typeof it.text === 'string') result.set(Number(it.id), it.text);
      if (result.size) return result;
    } catch {
      // fall through to the tolerant extractor
    }
  }
  for (const it of extractItems(text)) if (it.closed) result.set(it.id, it.text);
  return result;
}
