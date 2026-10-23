// Run details (spec 02 section 9.3): failures and processing events the user
// looks at on demand. Never contains frames, recognized text or translations.

export interface DetailEvent {
  at: string;
  kind: string;
  batch_seq?: number;
  node_id?: string;
  paragraph_id?: number;
  service?: string;
  reason?: string;
}

export class RunDetails {
  private readonly events: DetailEvent[] = [];
  private readonly max: number;
  private readonly listeners: Array<(e: DetailEvent) => void> = [];

  constructor(max = 5000) {
    this.max = max;
  }

  push(e: Omit<DetailEvent, 'at'>): void {
    const full = { at: new Date().toISOString(), ...e };
    this.events.push(full);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    for (const l of this.listeners) l(full);
  }

  onEvent(cb: (e: DetailEvent) => void): void {
    this.listeners.push(cb);
  }

  list(filter?: { kind?: string; batch_seq?: number }): DetailEvent[] {
    return this.events.filter((e) => (!filter?.kind || e.kind === filter.kind) && (filter?.batch_seq === undefined || e.batch_seq === filter.batch_seq));
  }
}
