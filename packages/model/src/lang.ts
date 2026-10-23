// Language tags (spec 00 section 3.5; requirement 09 section 3.2).

/** Canonical casing: language lowercase, script title-case, region uppercase. */
export function normalizeTag(tag: string): string {
  const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      if (p.length === 2 || /^\d{3}$/.test(p)) return p.toUpperCase();
      return p.toLowerCase();
    })
    .join('-');
}

/** RFC 4647 lookup: strip subtags from the end until a declared tag matches. */
export function supports(declared: readonly string[], tag: string): boolean {
  const set = new Set(declared.map(normalizeTag));
  let t = normalizeTag(tag);
  for (;;) {
    if (set.has(t)) return true;
    const i = t.lastIndexOf('-');
    if (i < 0) return false;
    t = t.slice(0, i);
  }
}

export function baseLanguage(tag: string): string {
  return normalizeTag(tag).split('-')[0];
}

export function scriptSubtag(tag: string): string | undefined {
  return normalizeTag(tag)
    .split('-')
    .slice(1)
    .find((p) => p.length === 4);
}

/**
 * Requirement 09 section 3.2: a paragraph needs no translation when its language is the
 * target language. Same primary subtag, and the same script when both name one:
 * zh and zh-Hans match, zh-Hant and zh-Hans do not (traditional to simplified is a translation).
 */
export function sameLanguage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === 'auto' || b === 'auto') return false;
  if (baseLanguage(a) !== baseLanguage(b)) return false;
  const sa = scriptSubtag(a);
  const sb = scriptSubtag(b);
  return !sa || !sb || sa === sb;
}
