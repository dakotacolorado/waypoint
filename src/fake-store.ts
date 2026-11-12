import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.ts";

/** The real store on a database in memory, with a read tests can hold so another write lands before its commit. */
export class FakeStore extends Store {
  private held?: { read: () => void; released: Promise<void> };
  /** Stands in for the stored version while set: NaN matches no read, so every commit is refused. */
  forcedVersion?: number;

  constructor() {
    super(new DatabaseSync(":memory:"));
  }

  /** The next read returns, but its writer waits for `release` before committing. */
  holdNextRead(): { read: Promise<void>; release: () => void } {
    let read!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (read = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.held = { read, released };
    return { read: reached, release };
  }

  protected override async snapshot() {
    const snapshot = await super.snapshot();
    const held = this.held;
    this.held = undefined;
    if (held) {
      held.read();
      await held.released;
    }
    return snapshot;
  }

  protected override storedVersion(): number {
    return this.forcedVersion ?? super.storedVersion();
  }
}
