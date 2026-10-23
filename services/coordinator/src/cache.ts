// Translation cache (spec 04 section 5): one per race node, keyed by kappa(text),
// least-recently-hit eviction. Kept across pauses, cleared on stop.
import { cacheKey } from '@sth/model';

export class TranslationCache {
  private readonly capacity: number;
  private readonly map = new Map<string, string>();

  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity);
  }

  get size(): number {
    return this.map.size;
  }

  has(text: string): boolean {
    return this.capacity > 0 && this.map.has(cacheKey(text));
  }

  /** Look up and mark as most recently used. */
  get(text: string): string | undefined {
    if (this.capacity === 0) return undefined;
    const k = cacheKey(text);
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  put(text: string, translation: string): void {
    if (this.capacity === 0) return;
    const k = cacheKey(text);
    this.map.delete(k);
    this.map.set(k, translation);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
