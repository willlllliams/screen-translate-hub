// Spec 06 section 3: fill in the writing direction when the engine gave none.
import { quadBounds, scriptHistogram, type Direction, type TextBlock } from '@sth/model';

export function inferDirection(block: TextBlock): Direction {
  if (block.direction) return block.direction;
  const b = quadBounds(block.quad);
  const chars = [...block.text.replace(/\s/g, '')].length;
  if (b.h > 1.5 * b.w && chars >= 2) return 'ttb';
  const h = scriptHistogram(block.text);
  const rtl = (h.get('arabic') ?? 0) + (h.get('hebrew') ?? 0);
  let others = 0;
  for (const [s, n] of h) if (s !== 'arabic' && s !== 'hebrew') others += n;
  return rtl > others ? 'rtl' : 'ltr';
}
