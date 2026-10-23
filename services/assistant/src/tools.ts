// Platform tools (spec 17 section 6): everything the AI can do. No mouse, keyboard,
// file or command tools exist, so the AI cannot act for the user (requirement 09 section 4.2).
// One definition each; the schemas are TypeBox, which is plain JSON Schema for MCP.
import type { Annotation, EncodedImage } from '@sth/model';
import sharp from 'sharp';
import { Type, type Static } from 'typebox';
import type { Platform } from './platform.ts';
import type { GateDecision, PlatformTool, ToolResult } from './types.ts';
import { foregroundWindow } from './win.ts';

export interface ToolContext {
  platform: Platform;
  task: () => string;
  recentGate: () => Array<GateDecision & { at: string }>;
  say: (text: string, mode: 'replace' | 'append') => void;
}

const Rect = Type.Object(
  { x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() },
  { description: 'Rectangle in physical screen pixels' },
);
const Point = Type.Object({ x: Type.Number(), y: Type.Number() }, { description: 'Point in physical screen pixels' });

const CaptureArgs = Type.Object({
  region: Type.Optional(Rect),
  max_width: Type.Optional(Type.Integer({ minimum: 320, maximum: 1920, description: 'Scale the image down to at most this width (default 1280)' })),
});
const OcrArgs = Type.Object({ region: Type.Optional(Rect) });
const AnnotationArg = Type.Object({
  kind: Type.Union([Type.Literal('box'), Type.Literal('arrow'), Type.Literal('bubble'), Type.Literal('highlight'), Type.Literal('label')]),
  rect: Type.Optional(Rect),
  from: Type.Optional(Point),
  to: Type.Optional(Point),
  point: Type.Optional(Point),
  text: Type.Optional(Type.String({ maxLength: 400 })),
  color: Type.Optional(Type.String({ description: 'CSS color, default orange-red' })),
  ttl_ms: Type.Optional(Type.Integer({ minimum: 1000, description: 'Remove after this many milliseconds; default: until cleared' })),
});
const AnnotateArgs = Type.Object({ items: Type.Array(AnnotationArg, { minItems: 1, maxItems: 20 }) });
const ClearArgs = Type.Object({ ids: Type.Optional(Type.Array(Type.String())) });
const SayArgs = Type.Object({
  text: Type.String({ maxLength: 4000 }),
  mode: Type.Optional(Type.Union([Type.Literal('replace'), Type.Literal('append')], { description: 'replace the card text, or append to it (default)' })),
});
const NoArgs = Type.Object({});

function bgraToRgb(src: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = src[i + 2];
    out[j + 1] = src[i + 1];
    out[j + 2] = src[i];
  }
  return out;
}

async function toJpeg(e: EncodedImage, maxWidth: number): Promise<{ data: Buffer; width: number; height: number }> {
  let p = e.format === 'raw_bgra8' ? sharp(bgraToRgb(e.data, e.width, e.height), { raw: { width: e.width, height: e.height, channels: 3 } }) : sharp(e.data);
  if (e.width > maxWidth) p = p.resize({ width: maxWidth });
  const { data, info } = await p.jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const json = (v: unknown): ToolResult => ({ text: JSON.stringify(v) });

export function platformTools(ctx: ToolContext): PlatformTool[] {
  const tools: PlatformTool[] = [
    {
      name: 'screen_capture',
      label: 'Look at the screen',
      description:
        'Capture what the user is looking at (the observed screen or window, or a region of the screen). The platform\'s own windows and the mouse pointer are not in the picture. Returns the image and how its pixels map to screen pixels.',
      parameters: CaptureArgs,
      async execute(raw) {
        const a = raw as Static<typeof CaptureArgs>;
        const img = await ctx.platform.grab(a.region);
        const g = img.geometry!;
        const jpg = await toJpeg(img.image, a.max_width ?? 1280);
        const s = img.image.width / jpg.width;
        return {
          text: `Image ${jpg.width}x${jpg.height}. Screen pixel of image point (u, v) = (${Math.round(g.origin_x)} + u*${s.toFixed(3)}, ${Math.round(g.origin_y)} + v*${s.toFixed(3)}). Use screen pixels for annotate.`,
          images: [{ data: jpg.data.toString('base64'), mimeType: 'image/jpeg' }],
        };
      },
    },
    {
      name: 'screen_ocr',
      label: 'Read the screen',
      description: 'Read the text on the observed screen or a region of it. Returns paragraphs with their text and their rectangles in screen pixels.',
      parameters: OcrArgs,
      async execute(raw) {
        const a = raw as Static<typeof OcrArgs>;
        const img = await ctx.platform.grab(a.region);
        return json({ paragraphs: await ctx.platform.read(img) });
      },
    },
    {
      name: 'translation_state',
      label: 'Current translations',
      description: 'The paragraphs of the running continuous screen translation: original text, translation, and rectangle in screen pixels. Empty when no continuous translation is running.',
      parameters: NoArgs,
      async execute() {
        return json({ paragraphs: (await ctx.platform.translations()) ?? [] });
      },
    },
    {
      name: 'annotate',
      label: 'Draw on the screen',
      description:
        'Draw boxes, arrows, speech bubbles, highlights or labels over the screen to point things out. Coordinates are physical screen pixels (take them from screen_ocr rectangles or the screen_capture mapping). Drawings never block the mouse or keyboard. Returns the ids of the drawings.',
      parameters: AnnotateArgs,
      async execute(raw) {
        const a = raw as Static<typeof AnnotateArgs>;
        const ids = await ctx.platform.annotate(a.items as Array<Omit<Annotation, 'id'>>);
        return json({ ids });
      },
    },
    {
      name: 'clear_annotations',
      label: 'Clear drawings',
      description: 'Remove drawings by id, or all drawings of this session when no ids are given.',
      parameters: ClearArgs,
      async execute(raw) {
        await ctx.platform.clearAnnotations((raw as Static<typeof ClearArgs>).ids);
        return { text: 'cleared' };
      },
    },
    {
      name: 'say',
      label: 'Show text in the card',
      description: 'Show text in the assistant card next to the screen. Your normal reply is shown there too; use this for short notes while you keep working, or to replace what the card shows.',
      parameters: SayArgs,
      async execute(raw) {
        const a = raw as Static<typeof SayArgs>;
        ctx.say(a.text, a.mode ?? 'append');
        return { text: 'shown' };
      },
    },
    {
      name: 'get_context',
      label: 'Context',
      description: "The user's task, the active window and the recent decisions about when to wake you.",
      parameters: NoArgs,
      async execute() {
        const fg = await foregroundWindow();
        return json({ task: ctx.task(), active_app: fg?.app ?? '', window_title: fg?.title ?? '', recent_wakes: ctx.recentGate().slice(-5), now: new Date().toISOString() });
      },
    },
  ];
  return tools;
}

/** The instructions every brain gets with the tools. */
export function systemPrompt(task: string): string {
  return [
    'You are a screen assistant. You sit next to the user and look at their screen with them.',
    'You can only look (screen_capture, screen_ocr, translation_state, get_context), point things out on the screen (annotate, clear_annotations) and talk in a small card (your reply, or say).',
    'You cannot click, type, open files or run commands, and you must not ask the user for permission to do those things.',
    'Keep replies short: the card is small. Prefer pointing with annotate over long descriptions of positions.',
    'When you were woken because the screen changed and there is nothing useful to say, reply with an empty message or a few words.',
    "Answer in the user's language.",
    task ? `The user's task: ${task}` : 'The user has not given a task; just keep them company and help when something is worth mentioning.',
  ].join('\n');
}
