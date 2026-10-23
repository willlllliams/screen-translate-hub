import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Direction, OcrResult, Quad, TextBlock, Unit } from '@sth/model';
import { joinLines, normalize } from '../src/normalize.ts';

function quad(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

let nextBlock = 1;
function blk(text: string, x: number, y: number, w: number, h: number, direction?: Direction): TextBlock {
  return { block_id: nextBlock++, text, quad: quad(x, y, w, h), direction };
}

function ocr(blocks: TextBlock[], rect = { x: 0, y: 0, w: 2000, h: 2000 }, scale = 1): OcrResult {
  return { run_id: 'r', batch_seq: 1, regions: [{ rect, scale, blocks, engine: 'test' }] };
}

function run(blocks: TextBlock[], reused: Unit[] = [], firstId = 1): Unit[] {
  return normalize({ ocr: ocr(blocks), reused, first_id: firstId, frame_width: 2000, frame_height: 2000 });
}

test('two columns: left column first, same-height lines stay apart', () => {
  const units = run([
    blk('Right column first line of the text', 1050, 100, 800, 20),
    blk('Left column first line of the text', 100, 100, 800, 20),
    blk('continues on the second line here.', 100, 126, 600, 20),
    blk('and the right one continues too.', 1050, 126, 620, 20),
  ]);
  assert.equal(units.length, 2);
  assert.match(units[0].text, /^Left column.*here\.$/);
  assert.match(units[1].text, /^Right column.*too\.$/);
  assert.deepEqual(units.map((u) => u.order), [1, 2]);
  assert.equal(units[0].lines?.length, 2);
});

test('fragments of one line are joined, boxes kept', () => {
  const units = run([blk('world', 160, 100, 60, 20), blk('Hello', 100, 100, 55, 20)]);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, 'Hello world');
  assert.equal(units[0].lines?.length, 2);
});

test('hyphenation and CJK joining (spec 06 section 7)', () => {
  assert.equal(joinLines('an exam-', 'ple text'), 'an example text');
  assert.equal(joinLines('这是一个', '段落'), '这是一个段落');
  assert.equal(joinLines('한국어', '문장'), '한국어 문장');
  assert.equal(joinLines('Hello', 'World'), 'Hello World');
});

test('sentence end on a short line ends the paragraph (condition 6)', () => {
  const units = run([
    blk('A long first line of a paragraph that spans the column', 100, 100, 900, 20),
    blk('and ends here.', 100, 126, 200, 20),
    blk('The next paragraph starts right below without a gap', 100, 152, 880, 20),
  ]);
  assert.equal(units.length, 2);
});

test('stacked menu labels are not merged (v1 rule)', () => {
  const units = run([
    blk('Open', 100, 100, 60, 20),
    blk('Save', 100, 126, 60, 20),
    blk('Close window', 100, 152, 140, 20),
  ]);
  assert.equal(units.length, 3);
});

test('a heading is not merged into the paragraph below it (v1 rule)', () => {
  // measured on Notepad: the heading gap is smaller than one line height
  const units = run([
    blk('Release notes', 593, 130, 109, 23),
    blk("We've launched the memory tool in beta, enabling the assistant to store and consult information across", 592, 169, 758, 24),
    blk('conversations.', 594, 192, 110, 20),
    blk('发布说明', 593, 240, 80, 23),
    blk('我们推出了测试版的记忆工具，使助手能够跨对话存储和查阅信息，并且可以在之后的会话里', 592, 279, 758, 24),
    blk('继续使用。', 594, 302, 110, 20),
  ]);
  assert.deepEqual(units.map((u) => u.lines?.length), [1, 2, 1, 2]);
});

test('extra spacing between paragraphs splits them even under kg (v1 rule)', () => {
  // measured on a Tk text widget: line pitch 21 px, paragraph pitch 35 px, boxes 21 px high
  const units = run([
    blk('The installer now runs without administrator rights and finishes in under a minute.', 596, 163, 713, 21),
    blk('When the installation finishes, start the program from the start menu. The first start', 596, 199, 714, 21),
    blk('takes a little longer because the program prepares its local cache.', 596, 220, 600, 21),
    blk('Open the settings page and choose the account section. Enter the address of your', 595, 255, 712, 21),
    blk('server and press the connect button.', 595, 276, 300, 21),
  ]);
  assert.deepEqual(units.map((u) => u.lines?.length), [1, 2, 2]);
});

test('single-line paragraphs with loose spacing stay apart, headings too (v1 rule)', () => {
  // measured on the Tk test window at 1366 px wide: every paragraph fits on one line, so the
  // usual gap is the paragraph gap itself (0.6 to 0.9 line heights)
  const units = run([
    blk('Before you begin, make sure that your computer meets the minimum requirements and that you have a stable network connection.', 21, 122, 909, 20),
    blk('Installation', 20, 158, 106, 24),
    blk('Download the installer from the releases page and run it. The installer asks where to put the program files and whether to create a desktop shortcut.', 21, 199, 1024, 20),
    blk('When the installation finishes, start the program from the start menu. The first start takes a little longer because the program prepares its local cache.', 21, 234, 1031, 20),
    blk('If the server uses a self-signed certificate, the program shows its fingerprint. Compare it with the one your administrator gave you before you accept it.', 21, 346 - 75, 1043, 20),
    blk('Running a job', 20, 383 - 75, 136, 27),
    blk('Select the files you want to process, pick a profile and press start. Progress is shown in the status bar at the bottom of the window.', 21, 423 - 75, 900, 20),
    blk('You can pause a running job at any time. Paused jobs keep their place in the queue and continue where they stopped.', 22, 458 - 75, 812, 20),
  ]);
  assert.deepEqual(units.map((u) => u.lines?.length), [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('a short line followed by a lowercase continuation still merges', () => {
  const units = run([
    blk('A long first line of a paragraph that spans the whole column', 100, 100, 900, 20),
    blk('short line', 100, 126, 120, 20),
    blk('continued in lowercase on the next line of the same paragraph', 100, 152, 880, 20),
  ]);
  assert.equal(units.length, 1);
});

test('vertical Japanese columns read right to left, bubbles separate', () => {
  const units = run([
    // bubble A on the right: two columns
    blk('こんにちは', 900, 100, 30, 150, 'ttb'),
    blk('げんきですか', 862, 100, 30, 170, 'ttb'),
    // bubble B on the left, far away
    blk('はい', 400, 100, 30, 60, 'ttb'),
  ]);
  assert.equal(units.length, 2);
  assert.equal(units[0].text, 'こんにちはげんきですか');
  assert.equal(units[0].direction, 'ttb');
  assert.equal(units[1].text, 'はい');
});

test('region coordinates are mapped back with offset and scale', () => {
  const units = normalize({
    ocr: ocr([blk('Scaled', 20, 10, 100, 40)], { x: 500, y: 300, w: 100, h: 50 }, 2),
    reused: [],
    first_id: 1,
    frame_width: 2000,
    frame_height: 2000,
  });
  assert.deepEqual(units[0].bounds, { x: 510, y: 305, w: 50, h: 20 });
});

test('reused paragraphs are atomic and keep their ids; new ones start at first_id', () => {
  const reused: Unit = {
    paragraph_id: 1,
    order: 0,
    text: 'Kept paragraph',
    direction: 'ltr',
    bounds: { x: 100, y: 100, w: 300, h: 20 },
    lines: [blk('Kept paragraph', 100, 100, 300, 20)],
    origin: 'reused',
  };
  const units = run([blk('New text below', 100, 400, 300, 20)], [reused], 2);
  assert.equal(units.length, 2);
  assert.equal(units[0].paragraph_id, 1);
  assert.equal(units[0].origin, 'reused');
  assert.equal(units[1].paragraph_id, 2);
  assert.deepEqual(units.map((u) => u.order), [1, 2]);
});

test('Arabic is inferred as right to left', () => {
  const ar = String.fromCharCode(0x645, 0x631, 0x62d, 0x628, 0x627);
  const units = run([blk(ar, 100, 100, 200, 20)]);
  assert.equal(units[0].direction, 'rtl');
});
