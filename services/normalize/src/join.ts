// Spec 06 section 7: how two consecutive lines join.
import { isCjk, isFullWidthPunct, scriptOf } from '@sth/model';

const HYPHENS = new Set(['-', String.fromCharCode(0x2010)]);

function lastChar(s: string): string {
  const chars = [...s];
  return chars[chars.length - 1] ?? '';
}

function firstChar(s: string): string {
  return [...s][0] ?? '';
}

export function joinLines(a: string, b: string): string {
  const ta = a.trimEnd();
  const tb = b.trimStart();
  if (!ta) return tb;
  if (!tb) return ta;
  const chars = [...ta];
  const la = chars[chars.length - 1];
  const beforeHyphen = chars[chars.length - 2] ?? '';
  const fb = firstChar(tb);
  // 1. exam- + ple -> example
  if (HYPHENS.has(la) && scriptOf(beforeHyphen) === 'latin' && /^[a-z]/.test(fb)) {
    return chars.slice(0, -1).join('') + tb;
  }
  // 2. CJK or full-width punctuation on either side: no space
  if (isCjk(la) || isFullWidthPunct(la) || isCjk(fb) || isFullWidthPunct(fb)) return ta + tb;
  // 3. otherwise one space (Hangul and Arabic included)
  return `${ta} ${tb}`;
}

export function endsWithSentencePunct(s: string): boolean {
  const c = lastChar(s.trimEnd());
  return ['.', '!', '?', String.fromCharCode(0x3002), String.fromCharCode(0xff01), String.fromCharCode(0xff1f), String.fromCharCode(0xff0e)].includes(c);
}

export function endsWithContinuation(s: string): boolean {
  const c = lastChar(s.trimEnd());
  return [',', ';', ':', '-', String.fromCharCode(0x2013), String.fromCharCode(0x2014), String.fromCharCode(0x3001), String.fromCharCode(0xff0c)].includes(c);
}
