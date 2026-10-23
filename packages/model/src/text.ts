// Text helpers: cache key normalization (spec 02 section 8) and scripts.

export type Script = 'han' | 'kana' | 'hangul' | 'arabic' | 'hebrew' | 'cyrillic' | 'thai' | 'latin' | 'other';

export function scriptOf(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2fa1f) || (c >= 0xf900 && c <= 0xfaff)) return 'han';
  if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) return 'kana';
  if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return 'hangul';
  if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return 'arabic';
  if (c >= 0x0590 && c <= 0x05ff) return 'hebrew';
  if (c >= 0x0400 && c <= 0x04ff) return 'cyrillic';
  if (c >= 0x0e00 && c <= 0x0e7f) return 'thai';
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) return 'latin';
  return 'other';
}

export function isCjk(ch: string): boolean {
  const s = scriptOf(ch);
  return s === 'han' || s === 'kana';
}

/** Full-width punctuation and CJK symbols. */
export function isFullWidthPunct(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xff65);
}

/** Unicode White_Space: String.prototype.trim covers all of it except U+0085. */
export function isWhiteSpace(ch: string): boolean {
  return ch.trim() === '' || ch.codePointAt(0) === 0x85;
}

/** kappa(u): NFC, collapse whitespace runs to one space, trim, drop spaces between Han/kana characters. */
export function cacheKey(text: string): string {
  const chars: string[] = [];
  let pendingSpace = false;
  for (const ch of text.normalize('NFC')) {
    if (isWhiteSpace(ch)) {
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) chars.push(' ');
    pendingSpace = false;
    chars.push(ch);
  }
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' && isCjk(chars[i - 1]) && isCjk(chars[i + 1])) continue;
    out += ch;
  }
  return out;
}

/**
 * Whether a paragraph has words worth translating (requirement 09 section 3.2): text
 * without letters (numbers, times, symbols, icons read as punctuation) and lone Latin,
 * Greek or Cyrillic letters (toolbar glyphs like B, I, X, H1) do not.
 */
export function hasWords(text: string): boolean {
  let run = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) {
      run = 0;
      continue;
    }
    if (!/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(ch)) return true; // a caseless script letter is a word on its own
    if (++run >= 2) return true;
  }
  return false;
}

/** Count characters by script, ignoring digits, punctuation and spaces. */
export function scriptHistogram(text: string): Map<Script, number> {
  const h = new Map<Script, number>();
  for (const ch of text) {
    const s = scriptOf(ch);
    if (s === 'other') continue;
    h.set(s, (h.get(s) ?? 0) + 1);
  }
  return h;
}
