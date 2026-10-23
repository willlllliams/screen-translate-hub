// Display settings (spec 07 section 6, requirement 09 section 3.1). Each display
// end keeps its own copy; changing them only re-renders.

/** plate: a translucent plate under each paragraph (default, william's old app); dim: dim the whole range. */
export type DisplayMode = 'plate' | 'dim';
/** Where a one-shot screenshot result appears. */
export type ScreenshotPlacement = 'inplace' | 'card';

export interface DisplaySettings {
  mode: DisplayMode;
  /** Plate opacity in plate mode, 0..1. */
  plate_opacity: number;
  plate_color: string;
  text_color: string;
  /** Brightness beta in dim mode: dim layer opacity is 1 - beta. */
  brightness: number;
  font_scale: number;
  min_font_px: number;
  show_translation: boolean;
  /** Web viewer: show the batch frame underneath. */
  show_frame: boolean;
  fonts: string[];
  refresh: 'immediate' | 'complete';
  data_saver: boolean;
  screenshot_placement: ScreenshotPlacement;
}

export function defaultSettings(kind: 'overlay' | 'web' | 'card' = 'overlay'): DisplaySettings {
  return {
    mode: 'plate',
    plate_opacity: 0.86,
    plate_color: '#2b2d31',
    text_color: '#ffffff',
    brightness: 0.35,
    font_scale: kind === 'web' ? 1.15 : 1,
    min_font_px: kind === 'web' ? 11 : 10,
    show_translation: true,
    show_frame: true,
    fonts: ['Microsoft YaHei UI', 'Segoe UI', 'Yu Gothic UI', 'Malgun Gothic', 'Noto Sans', 'sans-serif'],
    refresh: 'immediate',
    data_saver: false,
    screenshot_placement: 'inplace',
  };
}

export function mergeSettings(base: DisplaySettings, patch: Partial<DisplaySettings> | undefined): DisplaySettings {
  return { ...base, ...(patch ?? {}) };
}
