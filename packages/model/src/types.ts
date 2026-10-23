// Data model (spec 02). Field names follow the spec's snake_case so the same
// messages decode unchanged in Python.

export interface Point { x: number; y: number }
/** Integer pixel rectangle covering x <= i < x + w, y <= j < y + h. */
export interface Rect { x: number; y: number; w: number; h: number }
/** Float rectangle. */
export interface RectF { x: number; y: number; w: number; h: number }
/** Four points, clockwise as seen on screen, starting at the point with the smallest x + y (spec 02 section 1.2). */
export type Quad = [Point, Point, Point, Point];

export type Direction = 'ltr' | 'rtl' | 'ttb';

export interface CaptureGeometry {
  kind: 'display' | 'window' | 'region';
  display_id: string;
  window_id?: number;
  origin_x: number;
  origin_y: number;
  /** Frame pixels per desktop unit; 1 on Windows. */
  scale: number;
  width: number;
  height: number;
}

export type ImageFormat = 'raw_bgra8' | 'png' | 'webp_lossless' | 'webp' | 'jpeg';

export interface EncodedImage {
  format: ImageFormat;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Image {
  image: EncodedImage;
  geometry?: CaptureGeometry;
  captured_at: string;
}

export interface TextBlock {
  block_id: number;
  text: string;
  quad: Quad;
  direction?: Direction;
  confidence?: number;
  language?: string;
  char_quads?: Quad[];
}

export interface OcrRegion {
  rect: Rect;
  scale: number;
  blocks: TextBlock[];
  engine: string;
}

export interface OcrResult {
  run_id: string;
  batch_seq: number;
  regions: OcrRegion[];
}

export type UnitOrigin = 'recognized' | 'reused' | 'injected';

export interface ReuseRef {
  batch_seq: number;
  paragraph_id: number;
  dx: number;
  dy: number;
}

export interface Unit {
  paragraph_id: number;
  order: number;
  text: string;
  language?: string;
  direction?: Direction;
  lines?: TextBlock[];
  bounds?: RectF;
  origin: UnitOrigin;
  reused_from?: ReuseRef;
  context_text?: string;
}

export interface Candidate {
  run_id: string;
  batch_seq: number;
  paragraph_id: number;
  source_node: string;
  version: number;
  final: boolean;
  text: string;
}

export type EndState = 'complete' | 'partial' | 'provisional' | 'error' | 'aborted';
/** How the result came about; `same_language` and `no_words` are requirement 09 section 3.2. */
export type Via = 'race' | 'reuse' | 'cache' | 'same_language' | 'no_words';
export type EndedBy = 'settled' | 'all_ended' | 'deadline' | 'pause' | 'stop' | 'cancel';
export type SourceState = 'queued' | 'running' | 'finished' | 'failed' | 'unavailable' | 'cancelled' | 'pruned';

export interface SourceOutcome {
  state: SourceState;
  has_output: boolean;
  last_version: number;
  reason?: string;
}

export interface ShownRef {
  source: string;
  rank: number;
  version: number;
  final: boolean;
}

export interface RaceRecord {
  race_node: string;
  batch_seq: number;
  paragraph_id: number;
  shown: 'none' | 'candidate' | 'error';
  shown_candidate?: ShownRef;
  shown_text?: string;
  error_reason?: string;
  sources: Record<string, SourceOutcome>;
  end_state?: EndState;
  via: Via;
  ended_by?: EndedBy;
}

export interface Shift { dx: number; dy: number }

export interface ChangeMap {
  base_frame_id: number;
  frame_id: number;
  tile: number;
  cols: number;
  rows: number;
  /** shifts[0] is always {dx: 0, dy: 0}; at most 8 entries. */
  shifts: Shift[];
  /** One byte per tile, row-major; bit k set means the tile matches the old frame under shifts[k]. */
  masks: Uint8Array;
  changed_ratio: number;
}

// ---- display events (spec 02 section 10) ----

export interface RectRel { x: number; y: number; w: number; h: number }
/** Relative quad: x1 y1 x2 y2 x3 y3 x4 y4 in [0, 1]. */
export type QuadRel = number[];

export interface FrameRef { image_id: string; width: number; height: number }

export interface Carry { paragraph_id: number; from_paragraph_id: number; dx: number; dy: number }

export interface ParagraphAddBody {
  kind: 'paragraph_add';
  paragraph_id: number;
  text: string;
  language?: string;
  direction: Direction;
  quads: QuadRel[];
  bounds: RectRel;
  takes_over?: number;
}

export interface ParagraphShowBody {
  kind: 'paragraph_show';
  paragraph_id: number;
  show: 'text' | 'error';
  text?: string;
  source_rank?: number;
  version?: number;
  final?: boolean;
  error_reason?: string;
}

export interface Notice {
  notice_id: string;
  notice: 'preferred_unavailable';
  race_node: string;
  reason: string;
  active: boolean;
}

export type RunStateName = 'running' | 'paused' | 'stopped';

export type DisplayEventBody =
  | { kind: 'run_state'; state: RunStateName; reason?: string }
  | {
      kind: 'batch_start';
      batch_seq: number;
      frame?: FrameRef;
      geometry?: CaptureGeometry;
      carried: Carry[];
      held: number[];
    }
  | ParagraphAddBody
  | { kind: 'held_release'; paragraph_ids: number[] }
  | ParagraphShowBody
  | { kind: 'paragraph_end'; paragraph_id: number; end_state: EndState; via: Via }
  | ({ kind: 'notice' } & Notice)
  | { kind: 'batch_end'; batch_seq: number; ended_by: 'settled' | 'deadline' | 'pause' | 'stop' };

export interface DisplayEvent {
  stream_id: string;
  seq: number;
  run_id: string;
  ev: DisplayEventBody;
}

export interface ParagraphView {
  paragraph: ParagraphAddBody;
  shown?: ParagraphShowBody;
  end_state?: EndState;
  via?: Via;
}

export interface DisplaySnapshot {
  stream_id: string;
  seq: number;
  run_id: string;
  run_state: RunStateName;
  batch_seq: number;
  frame?: FrameRef;
  geometry?: CaptureGeometry;
  paragraphs: ParagraphView[];
  held: ParagraphView[];
  notices: Notice[];
}

// ---- assistant annotations (spec 17 section 7) ----

export type AnnotationKind = 'box' | 'arrow' | 'bubble' | 'highlight' | 'label';

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  /** Screen coordinates in physical pixels. */
  rect?: RectF;
  from?: Point;
  to?: Point;
  point?: Point;
  text?: string;
  color?: string;
  ttl_ms?: number;
  anchor?: 'screen' | 'window';
}

// ---- services ----

export interface InterfaceVersion { name: string; major: number; minor: number }

export interface Limits {
  max_concurrency: number;
  requests_per_second: number;
  burst: number;
  max_units_per_request: number;
  max_chars_per_request: number;
}

export interface ServiceManifest {
  name: string;
  display_name: string;
  interfaces: InterfaceVersion[];
  engine?: { id: string; name: string; version: string };
  languages?: { ocr?: string[]; source?: string[]; target?: string[]; detects_source?: boolean };
  platform?: { os: string; arch: string; accelerators: string[] };
  limits?: Partial<Limits>;
  streaming?: boolean;
  metering?: 'none' | 'calls' | 'characters' | 'tokens';
}

export interface CaptureRange {
  display_id?: string;
  window_id?: number;
  region?: { display_id?: string; x: number; y: number; w: number; h: number };
  follow_active_window?: boolean;
}
