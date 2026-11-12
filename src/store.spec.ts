import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tokens } from "./auth.ts";
import { FakeStore } from "./fake-store.ts";
import { Store } from "./store.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "waypoint-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Store on a file", () => {
  it("keeps tasks, labels, history, comments and tokens across a restart", async () => {
    const path = join(dir, "w.db");
    const first = Store.open(path);
    await first.createLabel({ name: "ui" });
    const task = await first.createTask({ title: "kept", labels: ["ui"], subtasks: [{ title: "step" }] }, "planner");
    await first.createComment(task.id, "noted", "agent-1");
    const token = new Tokens(first.db).create("fleet", false);
    first.db.close();

    const second = Store.open(path);
    expect((await second.tasks()).get(task.id)).toMatchObject({ title: "kept", subtasks: [{ id: "s1", title: "step" }] });
    expect((await second.labels()).find("ui").name).toBe("ui");
    expect((await second.history(task.id)).map((entry) => entry.action)).toEqual(["created"]);
    expect((await second.comments(task.id)).map((comment) => comment.body)).toEqual(["noted"]);
    expect(new Tokens(second.db).caller(token)).toEqual({ name: "fleet", admin: false });
    second.db.close();
  });

  it("backs up to a file another store opens with the same tasks, never leaving a partial copy", async () => {
    const live = Store.open(join(dir, "live.db"));
    const task = await live.createTask({ title: "in the copy" }, null);
    await live.backup(join(dir, "copy.db"));
    await live.updateTask(task.id, { title: "after" }, null);
    const copy = Store.open(join(dir, "copy.db"));
    expect((await copy.tasks()).get(task.id)!.title).toBe("in the copy");
    expect(existsSync(join(dir, "copy.db.partial"))).toBe(false);
    copy.db.close();
    live.db.close();
  });
});

describe("Store's writes", () => {
  it("rolls back every part of a write that fails part way", async () => {
    const store = new FakeStore();
    const task = await store.createTask({ title: "before" }, null);
    store.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT, 'refused'); END");
    await expect(store.updateTask(task.id, { title: "half" }, null)).rejects.toThrow("refused");
    expect((await store.tasks()).get(task.id)!.title).toBe("before");
  });

  it("records nothing for an update that changes nothing", async () => {
    const store = new FakeStore();
    const task = await store.createTask({ title: "same" }, null);
    await store.updateTask(task.id, { title: "same" }, null);
    expect(await store.history(task.id)).toHaveLength(1);
  });
});
