// Types of the AI assistant (spec 17): session, heartbeat samples, gates, brains, tools.
import type { CaptureRange } from '@sth/model';

export type SessionState = 'idle' | 'watching' | 'thinking' | 'paused' | 'stopped';

export interface HeartbeatSample {
  at: string;
  /** Changed area since the frame of the last wake, 0..1. */
  changed_ratio: number;
  /** Time since the picture last changed between two samples. */
  changed_since_ms: number;
  active_app: string;
  window_title: string;
  app_switched: boolean;
  ocr_excerpt?: string;
  user_idle_ms: number;
}

export interface GateInput {
  sample: HeartbeatSample;
  task: string;
  paused: boolean;
  last_wake_at?: string;
  wakes_last_hour: number;
}

export interface GateDecision {
  wake: boolean;
  /** 0..1 */
  confidence: number;
  /** Shown in the card's status line and written to the session log. */
  reason: string;
  /** The gate that made the decision (a composite names the inner one). */
  by?: string;
}

export interface Gate {
  readonly name: string;
  decide(input: GateInput, signal: AbortSignal): Promise<GateDecision>;
}

export interface WakeEvent {
  kind: 'user_message' | 'gate' | 'hotkey';
  text?: string;
  decision?: GateDecision;
  sample?: HeartbeatSample;
}

export type BrainEvent =
  | { type: 'status'; text: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  | { type: 'turn_end'; stop: 'done' | 'error' | 'cancelled'; error?: string };

/** What a tool gives back: text and optionally images (the screen). */
export interface ToolResult {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  isError?: boolean;
}

export interface PlatformTool {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema; serializes to plain JSON Schema for MCP. */
  parameters: object;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface Brain {
  readonly name: string;
  open(task: string, tools: PlatformTool[]): Promise<void>;
  wake(ev: WakeEvent, signal: AbortSignal): AsyncIterable<BrainEvent>;
  /** The user changed the task after open(); the brain tells the model on the next wake. */
  setTask?(task: string): void;
  close(): Promise<void>;
}

export interface SessionStart {
  task: string;
  range?: CaptureRange;
  heartbeat_ms?: number;
  brain?: string;
  gate?: string;
}

/** Messages from the card (through the desktop app) to a session. */
export type SessionClientMessage =
  | { start: SessionStart }
  | { user_message: { text: string } }
  | { pause: Record<string, never> }
  | { resume: Record<string, never> }
  | { stop: Record<string, never> }
  | { clear_annotations: Record<string, never> }
  | { set_task: { task: string } };

/** Messages from a session to the card. */
export type SessionServerMessage =
  | { started: { session_id: string; brain: string; gate: string } }
  | { state: { state: SessionState; reason?: string } }
  | { brain: BrainEvent }
  | { gate: GateDecision & { at: string } }
  | { say: { text: string; mode: 'replace' | 'append' } };
