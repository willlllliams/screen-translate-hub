// Internal parameters of normalization (spec 06 section 9). Not workflow parameters:
// they set layout-analysis quality and ship with the service version.

export interface NormalizeParams {
  /** Minimum relative gap for a recursive XY cut. */
  gMin: number;
  /** Maximum glyph-size ratio of two lines in one paragraph. */
  kh: number;
  /** Allowed overlap of consecutive line boxes, in line heights. */
  kv: number;
  /** Maximum line gap, in line heights. */
  kg: number;
  /** Minimum overlap along the line direction, as a fraction of the shorter line. */
  ko: number;
  /** A line ending with sentence punctuation and shorter than ks x column width ends its paragraph. */
  ks: number;
  /** Fragment joining (section 4): minimum overlap across the line, fraction of the smaller glyph size. */
  fragOverlap: number;
  /** Fragment joining: maximum gap, fraction of the smaller glyph size. */
  fragGap: number;
  /** v1 addition: a "short" line is narrower than this fraction of the column width. */
  shortLine: number;
  /** v1 addition: a gap wider than the leaf's usual line gap by this many line heights is a paragraph break. */
  kp: number;
  /** v1 addition: past this gap, in line heights, a sentence end or a heading ends the paragraph. */
  ksg: number;
  /** v1 addition: a short line at least this much taller than the line above is a heading. */
  kHead: number;
}

export const DEFAULT_PARAMS: NormalizeParams = {
  gMin: 1.2,
  kh: 1.35,
  kv: 0.35,
  kg: 0.9,
  ko: 0.3,
  ks: 0.85,
  fragOverlap: 0.6,
  fragGap: 0.5,
  shortLine: 0.6,
  kp: 0.4,
  ksg: 0.55,
  kHead: 1.15,
};
