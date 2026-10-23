// Typed access to the preload bridge.
export interface Bridge {
  on(cb: (msg: Record<string, unknown>) => void): void;
  send(msg: unknown): void;
  invoke(msg: unknown): Promise<unknown>;
}

export const sth = (window as unknown as { sth: Bridge }).sth;
