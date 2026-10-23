// Workflow document (spec 03 section 1).

export type Entry = 'screenshot' | 'continuous' | 'selection' | 'image_dialog' | 'image_hint' | 'assistant';

/** "local" | "backend" | "device:<uuid>" (spec 03 section 4.1). */
export type Location = string;

export interface Binding {
  location: Location;
  service?: string;
}

export interface NodeDef {
  id: string;
  type: string;
  binding?: Binding;
  params: Record<string, unknown>;
}

export interface EdgeDef {
  from: string;
  to: string;
}

export interface GlossaryItem {
  source: string;
  target: string;
  note?: string;
}

export interface WorkflowDoc {
  format_version: 1;
  workflow_id: string;
  revision: number;
  name: string;
  entry: Entry;
  coordinator: 'local' | 'backend';
  parameters: Record<string, number | null>;
  glossary: GlossaryItem[];
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export type DataType = 'Image' | 'BatchFeed' | 'OcrResult' | 'Units' | 'Candidates' | 'Translation' | 'Reply';

export interface PortSpec {
  name: string;
  types: DataType[];
  required?: boolean;
  multi?: boolean;
}

export interface NodeSpec {
  category: 'input' | 'processing' | 'flow' | 'output';
  inputs: PortSpec[];
  outputs: PortSpec[];
  /** Executed by the coordinator itself: no binding. */
  coordinatorNode?: boolean;
}
