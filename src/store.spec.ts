import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tokens } from "./auth.ts";
import type { Draft } from "./domain.ts";
import { FakeStore } from "./fake-store.ts";
import { ConflictError, WorkItemStore } from "./store.ts";

const draft = (over: Partial<Draft> = {}): Draft => ({
  type: "epic",
  title: "E",
  body: "",
  acceptanceCriteria: [],
  status: "backlog",
  parent: null,
  dependsOn: [],
  ...over,
});

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "waypoint-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WorkItemStore on a file", () => {
  it("keeps items, tags, history, notes, the queue and tokens across a restart", async () => {
    const path = join(dir, "w.db");
    const first = WorkItemStore.open(path);
    const epic = await first.create(draft());
    const story = await first.create(draft({ type: "story", title: "S", parent: epic.id }));
    const tag = await first.createTag({ value: "ui", color: "#123456", description: "" });
    await first.tagItem(epic.id, "ui");
    await first.addNote({ id: "n1", item: story.id, kind: "work", author: "w", at: new Date().toISOString(), body: "did it", links: [] });
    await first.setQueueLimit(3, null);
    const token = new Tokens(first.db).create("worker", false);
    first.db.close();

    const second = WorkItemStore.open(path);
    const graph = await second.graph();
    expect(graph.get(story.id)).toMatchObject({ title: "S", parent: epic.id, tags: [tag.id] });
    expect((await second.history(story.id))!.map((entry) => entry.action)).toEqual(["created", "updated"]);
    expect((await second.notes(story.id, "work"))!.map((note) => note.body)).toEqual(["did it"]);
    expect((await second.queueSettings()).limit).toBe(3);
    expect(new Tokens(second.db).caller(token)).toEqual({ name: "worker", admin: false });
    second.db.close();
  });
});

describe("WorkItemStore.backup", () => {
  it("copies the database to a file another store opens with the same items", async () => {
    const store = WorkItemStore.open(join(dir, "live.db"));
    const epic = await store.create(draft({ title: "kept in the copy" }));
    await store.backup(join(dir, "copy.db"));
    await store.update(epic.id, { title: "changed after" });
    const copy = WorkItemStore.open(join(dir, "copy.db"));
    expect((await copy.graph()).get(epic.id)!.title).toBe("kept in the copy");
    expect(existsSync(join(dir, "copy.db.partial"))).toBe(false);
    copy.db.close();
    store.db.close();
  });
});

describe("WorkItemStore's writes", () => {
  it("decides again from a fresh read when another write lands between its read and its commit", async () => {
    const store = new FakeStore();
    const epic = await store.create(draft());
    const { read, release } = store.holdNextRead();
    const slow = store.update(epic.id, { title: "slow" });
    await read;
    await store.update(epic.id, { body: "landed first" });
    release();
    expect(await slow).toMatchObject({ title: "slow", body: "landed first" });
  });

  it("gives up with ConflictError when no read stays current, writing nothing", async () => {
    const store = new FakeStore();
    const epic = await store.create(draft());
    store.version = Number.NaN;
    await expect(store.update(epic.id, { title: "never" })).rejects.toBeInstanceOf(ConflictError);
    expect(store.items[0]!.title).toBe("E");
  });

  it("rolls back every part of a write that fails part way", async () => {
    const store = new FakeStore();
    const epic = await store.create(draft());
    store.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'refused'); END");
    await expect(store.update(epic.id, { title: "half" })).rejects.toThrow("refused");
    expect(store.items[0]!.title).toBe("E");
    store.db.exec("DROP TRIGGER refuse");
    expect(await store.update(epic.id, { title: "whole" })).toMatchObject({ title: "whole" });
  });

  it("files a write beneath an item under it and every item above", async () => {
    const store = new FakeStore();
    const epic = await store.create(draft());
    const story = await store.create(draft({ type: "story", title: "S", parent: epic.id }));
    const task = await store.create(draft({ type: "task", title: "T", parent: story.id }));
    await store.createTag({ value: "ui", color: "#123456", description: "" });
    await store.tagItem(story.id, "ui");
    const tagged = (entries: { item: string; action: string }[]) => entries.filter((entry) => entry.action === "updated").map((entry) => entry.item);
    expect(tagged((await store.history(task.id))!)).toEqual([task.id]);
    expect(tagged((await store.history(story.id))!)).toEqual([story.id, task.id]);
    expect(tagged((await store.history(epic.id))!)).toEqual([story.id, task.id]);
  });
});
