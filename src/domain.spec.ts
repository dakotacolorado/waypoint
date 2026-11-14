import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, Tasks, ValidationError, type Task, type TaskInput } from "./domain.ts";

const NOW = "2026-11-12T00:00:00.000Z";

/** A set of tasks built by applying inputs in turn, as the store does, checking each. */
class Board {
  tasks = new Tasks([]);
  private n = 0;

  add(input: TaskInput): Task {
    const id = `${String(++this.n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const task = this.tasks.apply(null, { title: "T", ...input }, "planner", NOW, id);
    this.tasks.check(null, task);
    this.tasks = new Tasks([...this.tasks.all(), task]);
    return task;
  }

  update(id: string, input: TaskInput, actor: string | null = "worker"): Task {
    const current = this.tasks.find(id);
    const next = this.tasks.apply(current, input, actor, NOW);
    this.tasks.check(current, next);
    this.tasks = new Tasks(this.tasks.all().map((task) => (task.id === id ? next : task)));
    return next;
  }
}

describe("a task's dependencies", () => {
  it("make it ready only once every task it depends on is closed, done or cancelled", () => {
    const board = new Board();
    const a = board.add({});
    const b = board.add({});
    const c = board.add({ dependsOn: [a.id, b.id] });
    expect(board.tasks.view(c)).toMatchObject({ ready: false, blockedBy: [a.id, b.id] });
    board.update(a.id, { status: "done" });
    board.update(b.id, { status: "cancelled" });
    expect(board.tasks.view(board.tasks.get(c.id)!)).toMatchObject({ ready: true, blockedBy: [] });
  });

  it("refuse a move to in_progress, review or done while one is open, naming it", () => {
    const board = new Board();
    const a = board.add({});
    const b = board.add({ dependsOn: [a.id] });
    for (const status of ["in_progress", "review", "done"] as const) {
      const refused = (() => {
        try {
          board.update(b.id, { status });
        } catch (err) {
          return err;
        }
      })();
      expect(refused).toBeInstanceOf(ConflictError);
      expect((refused as ConflictError).details).toEqual({ blockedBy: [a.id] });
    }
    expect(() => board.update(b.id, { status: "cancelled" })).not.toThrow();
  });

  it("refuse itself, a task that doesn't exist, and a cycle", () => {
    const board = new Board();
    const a = board.add({});
    const b = board.add({ dependsOn: [a.id] });
    expect(() => board.update(a.id, { dependsOn: [a.id] })).toThrow(ValidationError);
    expect(() => board.update(a.id, { dependsOn: ["99999999-0000-4000-8000-000000000000"] })).toThrow(NotFoundError);
    expect(() => board.update(a.id, { dependsOn: [b.id] })).toThrow(/cycle/);
  });
});

describe("done", () => {
  it("needs every criterion met and every subtask closed", () => {
    const board = new Board();
    const task = board.add({ criteria: [{ text: "builds" }], subtasks: [{ title: "write" }, { title: "drop" }] });
    expect(() => board.update(task.id, { status: "done" })).toThrow("criterion c1 is unmet");
    board.update(task.id, { criteria: [{ id: "c1", met: true }] });
    expect(() => board.update(task.id, { status: "done" })).toThrow("subtasks s1, s2 are open");
    board.update(task.id, { subtasks: [{ id: "s1", status: "done" }, { id: "s2", status: "cancelled" }] });
    expect(board.update(task.id, { status: "done" }).status).toBe("done");
  });

  it("stays true: a done task refuses a new unmet criterion", () => {
    const board = new Board();
    const task = board.add({ status: "done" });
    expect(() => board.update(task.id, { criteria: [{ text: "late" }] })).toThrow(ConflictError);
  });
});

describe("subtasks", () => {
  it("get ids s1, s2, … in order, so one request can make them depend on each other", () => {
    const board = new Board();
    const task = board.add({ subtasks: [{ title: "a" }, { title: "b", dependsOn: ["s1"] }] });
    expect(board.tasks.view(task).subtasks).toEqual([
      { id: "s1", title: "a", description: "", status: "backlog", dependsOn: [], blockedBy: [] },
      { id: "s2", title: "b", description: "", status: "backlog", dependsOn: ["s1"], blockedBy: ["s1"] },
    ]);
  });

  it("hold each other to the same gate, while the task itself may start", () => {
    const board = new Board();
    const task = board.add({ subtasks: [{ title: "a" }, { title: "b", dependsOn: ["s1"] }] });
    expect(board.update(task.id, { status: "in_progress" }).status).toBe("in_progress");
    expect(() => board.update(task.id, { subtasks: [{ id: "s1" }, { id: "s2", status: "in_progress" }] })).toThrow("subtask s2 is blocked by s1: close it first");
    board.update(task.id, { subtasks: [{ id: "s1", status: "done" }, { id: "s2" }] });
    expect(board.update(task.id, { subtasks: [{ id: "s1" }, { id: "s2", status: "in_progress" }] }).subtasks[1]!.status).toBe("in_progress");
  });

  it("keep fields an entry leaves out, drop entries left out, and never reuse an id in the same write", () => {
    const board = new Board();
    const task = board.add({ subtasks: [{ title: "a", description: "first" }, { title: "b" }] });
    const next = board.update(task.id, { subtasks: [{ id: "s1", title: "A" }, { title: "c" }] });
    expect(next.subtasks.map((sub) => [sub.id, sub.title, sub.description])).toEqual([
      ["s1", "A", "first"],
      ["s3", "c", ""],
    ]);
  });

  it("refuse an unknown id, a dependency the task doesn't have, and a cycle", () => {
    const board = new Board();
    const task = board.add({ subtasks: [{ title: "a" }, { title: "b" }] });
    expect(() => board.update(task.id, { subtasks: [{ id: "s9" }] })).toThrow(/no subtask s9/);
    expect(() => board.update(task.id, { subtasks: [{ id: "s1", dependsOn: ["s5"] }, { id: "s2" }] })).toThrow(/doesn't have/);
    expect(() => board.update(task.id, { subtasks: [{ id: "s1", dependsOn: ["s2"] }, { id: "s2", dependsOn: ["s1"] }] })).toThrow(/cycle/);
  });

  it("are cancelled with their task, those already closed kept", () => {
    const board = new Board();
    const task = board.add({ subtasks: [{ title: "a", status: "done" }, { title: "b" }] });
    expect(board.update(task.id, { status: "cancelled" }).subtasks.map((sub) => sub.status)).toEqual(["done", "cancelled"]);
  });
});

describe("criteria", () => {
  it("record who marked one met and when, and clear both when it is unmarked", () => {
    const board = new Board();
    const task = board.add({ criteria: [{ text: "same" }, { text: "same" }] });
    const met = board.update(task.id, { criteria: [{ id: "c1" }, { id: "c2", met: true }] }, "agent-2");
    expect(met.criteria).toEqual([
      { id: "c1", text: "same", met: false, metBy: null, metAt: null },
      { id: "c2", text: "same", met: true, metBy: "agent-2", metAt: NOW },
    ]);
    expect(board.update(task.id, { criteria: [{ id: "c1" }, { id: "c2", met: false }] }).criteria[1]).toMatchObject({ met: false, metBy: null, metAt: null });
  });

  it("refuse a new one without text", () => {
    const board = new Board();
    expect(() => board.add({ criteria: [{ met: true }] })).toThrow(/needs its text/);
  });
});

describe("short ids", () => {
  it("find a task by any prefix of 8 or more, and refuse one that matches two", () => {
    const tasks = new Tasks([
      { id: "abcdef01-0000-4000-8000-000000000001", title: "A", description: "", status: "backlog", dependsOn: [], subtasks: [], criteria: [], labels: [], assignee: null, verification: null, createdAt: NOW, updatedAt: NOW },
      { id: "abcdef01-9999-4000-8000-000000000002", title: "B", description: "", status: "backlog", dependsOn: [], subtasks: [], criteria: [], labels: [], assignee: null, verification: null, createdAt: NOW, updatedAt: NOW },
    ]);
    expect(tasks.shortId("abcdef01-0000-4000-8000-000000000001")).toBe("abcdef01-0");
    expect(tasks.find("abcdef01-9").title).toBe("B");
    expect(() => tasks.find("abcdef01")).toThrow(ConflictError);
    expect(() => tasks.find("abc")).toThrow(NotFoundError);
  });
});
