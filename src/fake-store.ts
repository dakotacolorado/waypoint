import { DatabaseSync } from "node:sqlite";
import { WorkItem } from "./domain.ts";
import { WorkItemStore } from "./store.ts";

/**
 * The real store on a database in memory, with what tests need to reach
 * under the API: the stored items, the set's version, and a held read.
 */
export class FakeStore extends WorkItemStore {
  private held?: { read: () => void; released: Promise<void> };
  /** Stands in for the stored version while set, as a record no write can match. */
  private forcedVersion?: number;

  constructor() {
    super(new DatabaseSync(":memory:"));
  }

  /** Every stored item, as read back. */
  get items(): WorkItem[] {
    return (this.db.prepare("SELECT record FROM items ORDER BY rowid").all() as { record: string }[]).map((row) =>
      WorkItemStore.itemFromRecord(JSON.parse(row.record) as Record<string, unknown>),
    );
  }

  get version(): number {
    return this.storedVersion();
  }

  set version(value: number) {
    this.forcedVersion = value;
  }

  protected override storedVersion(): number {
    return this.forcedVersion ?? super.storedVersion();
  }

  /** Stores the item as given, bypassing validation, as a record written by an older version would be. */
  put(item: WorkItem): void {
    this.db
      .prepare("INSERT INTO items (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record")
      .run(item.id, JSON.stringify(item.toJSON()));
  }

  /** Gives a stored item `dependsOn` as written before the sibling rule, bypassing validation. */
  depend(id: string, dependsOn: string[]): void {
    const item = this.items.find((each) => each.id === id)!;
    this.put(new WorkItem({ ...item.toJSON(), dependsOn }));
  }

  /** Stores the queue's settings record as given. */
  set queueStored(record: Record<string, unknown>) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('queue', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(record));
  }

  /**
   * The next read returns, but its writer waits for `release` before going on,
   * so another write can land between that read and its commit.
   */
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
}
