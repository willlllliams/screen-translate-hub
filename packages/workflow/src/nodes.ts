// Node catalog and port types (spec 03 sections 2 and 3).
import type { DataType, Entry, NodeSpec } from './types.ts';

const p = (name: string, types: DataType[], extra: { required?: boolean; multi?: boolean } = {}) => ({ name, types, ...extra });

export const NODE_SPECS: Record<string, NodeSpec> = {
  screen_input: { category: 'input', inputs: [], outputs: [p('batches', ['BatchFeed'])] },
  screenshot_input: { category: 'input', inputs: [], outputs: [p('image', ['Image'])] },
  selection_input: { category: 'input', inputs: [], outputs: [p('translate', ['Units']), p('ask_ai', ['Units'])] },
  image_input: { category: 'input', inputs: [], outputs: [p('image', ['Image'])] },
  ocr: { category: 'processing', inputs: [p('image', ['Image', 'BatchFeed'], { required: true })], outputs: [p('result', ['OcrResult'])] },
  normalize: { category: 'processing', inputs: [p('result', ['OcrResult'], { required: true })], outputs: [p('units', ['Units'])] },
  translate: { category: 'processing', inputs: [p('units', ['Units'], { required: true })], outputs: [p('candidates', ['Candidates'])] },
  race: {
    category: 'processing',
    coordinatorNode: true,
    inputs: [p('units', ['Units'], { required: true }), p('sources', ['Candidates'], { required: true, multi: true })],
    outputs: [p('translation', ['Translation'])],
  },
  llm_chat: { category: 'processing', inputs: [p('units', ['Units'], { required: true })], outputs: [p('reply', ['Reply'])] },
  vision_ai: { category: 'processing', inputs: [p('image', ['Image'], { required: true })], outputs: [p('reply', ['Reply'])] },
  http_request: { category: 'processing', inputs: [p('units', ['Units'], { required: true })], outputs: [p('candidates', ['Candidates']), p('reply', ['Reply'])] },
  switch: { category: 'flow', coordinatorNode: true, inputs: [p('input', ['Units'], { required: true })], outputs: [p('else', ['Units'])] },
  screenshot_card: { category: 'output', inputs: [p('image', ['Image']), p('translation', ['Translation'], { required: true })], outputs: [] },
  selection_card: { category: 'output', inputs: [p('candidates', ['Candidates']), p('reply', ['Reply'])], outputs: [] },
  overlay: { category: 'output', inputs: [p('translation', ['Translation'], { required: true })], outputs: [] },
  web_display: { category: 'output', inputs: [p('batches', ['BatchFeed'], { required: true }), p('translation', ['Translation'], { required: true })], outputs: [] },
  mouse_hint: { category: 'output', inputs: [p('reply', ['Reply'], { required: true })], outputs: [] },
  desktop_dialog: { category: 'output', inputs: [p('image', ['Image']), p('reply', ['Reply'], { required: true })], outputs: [] },
  web_dialog: { category: 'output', inputs: [p('reply', ['Reply'], { required: true })], outputs: [] },
  save_history: { category: 'output', inputs: [p('input', ['Image', 'Units', 'Candidates', 'Translation', 'Reply'], { required: true })], outputs: [] },
};

export const ENTRY_INPUT: Record<Entry, string> = {
  screenshot: 'screenshot_input',
  continuous: 'screen_input',
  selection: 'selection_input',
  image_dialog: 'image_input',
  image_hint: 'image_input',
  assistant: 'screen_input',
};

export function nodeSpec(type: string): NodeSpec | undefined {
  return NODE_SPECS[type];
}
