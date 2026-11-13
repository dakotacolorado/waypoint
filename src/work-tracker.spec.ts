import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.ts";
import { Store } from "./store.ts";
import { epicLabelName, importWorkTracker, readWorkTracker, seededId, statusOf, type OldHistoryEntry, type OldItem, type Source } from "./work-tracker.ts";

const EPIC = "e1e1e1e1-0000-4000-8000-000000000001";
const STORY = "51515151-0000-4000-8000-000000000002";
const OTHER_EPIC = "e2e2e2e2-0000-4000-8000-000000000003";
const OTHER_STORY = "52525252-0000-4000-8000-000000000004";
const TASK_A = "7a7a7a7a-0000-4000-8000-000000000005";
const TASK_B = "7b7b7b7b-0000-4000-8000-000000000006";
const TAG = "7a900000-0000-4000-8000-000000000007";

const item = (fields: Partial<OldItem> & Pick<OldItem, "id" | "type" | "title">): OldItem => ({
  shortId: fields.id.slice(0, 8),
  body: "",
  acceptanceCriteria: [],
  met: [],
  status: "backlog",
  state: "open",
  closedReason: null,
  parent: null,
  dependsOn: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  heldBy: null,
  tags: [],
  ...fields,
});

const created = (of: OldItem, at = of.createdAt, by = "planner"): OldHistoryEntry => ({
  item: of.id,
  action: "created",
  changes: [{ field: "title", from: null, to: of.title }],
  at,
  claimedBy: by,
  overrode: [],
});

/** Two epics; a story with two tasks, one depending on the other, under the first; a closed story under the second, depending across. */
function source(): Source {
  const epic = item({ id: EPIC, type: "epic", title: "The epic", status: "in_progress", tags: [TAG] });
  const story = item({
    id: STORY,
    type: "story",
    title: "The story",
    body: "Story body",
    parent: EPIC,
    status: "ready",
    tags: [TAG],
    heldBy: "agent-1",
    acceptanceCriteria: ["works", "documented"],
    met: [{ criterion: "works", by: "reviewer-1", at: "2026-11-03T00:00:00.000Z" }],
    dependsOn: [OTHER_STORY],
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  });
  const taskA = item({ id: TASK_A, type: "task", title: "First step", body: "Do it", parent: STORY, state: "closed", closedReason: "completed", status: "done", acceptanceCriteria: ["ran"], met: [{ criterion: "ran", by: "agent-1", at: "2026-11-03T00:00:00.000Z" }], createdAt: "2026-11-02T01:00:00.000Z" });
  const taskB = item({ id: TASK_B, type: "task", title: "Second step", parent: STORY, dependsOn: [TASK_A, OTHER_STORY], state: "closed", closedReason: "not_planned", status: "in_progress", createdAt: "2026-11-02T02:00:00.000Z" });
  const otherEpic = item({ id: OTHER_EPIC, type: "epic", title: "Other epic", state: "closed", closedReason: "completed", status: "done" });
  const otherStory = item({ id: OTHER_STORY, type: "story", title: "Other story", parent: OTHER_EPIC, state: "closed", closedReason: "not_planned", status: "backlog" });
  const items = [epic, story, taskA, taskB, otherEpic, otherStory];
  const detail: Source["detail"] = Object.fromEntries(items.map((each) => [each.id, { history: [created(each)], comments: [], workLog: [] }]));
  // An item's history holds what was written beneath it too.
  detail[STORY]!.history.push(created(taskA), { item: STORY, action: "updated", changes: [{ field: "status", from: "backlog", to: "ready" }], at: "2026-11-04T00:00:00.000Z", claimedBy: null, overrode: [] });
  detail[EPIC]!.history.push(...detail[STORY]!.history);
  detail[STORY]!.comments.push({ id: "c0000000-0000-4000-8000-000000000001", item: STORY, author: null, at: "2026-11-03T00:00:00.000Z", body: "A question" });
  detail[STORY]!.workLog.push({ id: "c0000000-0000-4000-8000-000000000002", item: STORY, author: "agent-1", at: "2026-11-02T12:00:00.000Z", body: "Opened the PR.", links: ["https://example.com/pull/1"] });
  detail[TASK_A]!.workLog.push({ id: "c0000000-0000-4000-8000-000000000003", item: TASK_A, author: "agent-1", at: "2026-11-02T13:00:00.000Z", body: "Step done.", links: [] });
  return {
    items,
    tags: [{ id: TAG, value: "waypoint", color: "#b03a6a", description: "The tracker", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }],
    detail,
  };
}

const fresh = () => new Store(new DatabaseSync(":memory:"));
const version = (store: Store) => (store.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined)?.value;

describe("statusOf", () => {
  it("maps a close as completed to done, as not planned to cancelled, and an open ready to backlog", () => {
    expect(statusOf({ status: "in_progress", state: "closed", closedReason: "completed" })).toBe("done");
    expect(statusOf({ status: "done", state: "closed", closedReason: "not_planned" })).toBe("cancelled");
    expect(statusOf({ status: "ready", state: "open", closedReason: null })).toBe("backlog");
    expect(statusOf({ status: "review", state: "open", closedReason: null })).toBe("review");
  });
});

describe("importWorkTracker", () => {
  it("makes each epic and story a task with its id, short id, timestamps and labels, and each old task a subtask of its story", async () => {
    const store = fresh();
    const report = importWorkTracker(store.db, source());
    expect(report.tasks).toEqual({ created: 4, updated: 0, unchanged: 0 });
    expect(report.subtasks).toBe(2);
    expect(report.clashes).toEqual([]);

    const tasks = await store.tasks();
    const labels = await store.labels();
    const epicLabel = labels.find(epicLabelName({ shortId: EPIC.slice(0, 8) }));
    expect(epicLabel).toMatchObject({ id: seededId(`work-tracker epic label ${EPIC}`), description: "The epic" });
    expect(labels.find("waypoint")).toMatchObject({ id: TAG, color: "#b03a6a" });

    const story = tasks.view(tasks.get(STORY)!);
    expect(story).toMatchObject({
      shortId: STORY.slice(0, 8),
      title: "The story",
      description: "Story body",
      status: "backlog",
      dependsOn: [OTHER_STORY],
      labels: [TAG, epicLabel.id],
      assignee: "agent-1",
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      criteria: [
        { id: "c1", text: "works", met: true, metBy: "reviewer-1", metAt: "2026-11-03T00:00:00.000Z" },
        { id: "c2", text: "documented", met: false, metBy: null, metAt: null },
      ],
    });
    expect(story.subtasks.map(({ id, title, status, dependsOn }) => ({ id, title, status, dependsOn }))).toEqual([
      { id: "s1", title: "First step", status: "done", dependsOn: [] },
      { id: "s2", title: "Second step", status: "cancelled", dependsOn: ["s1"] },
    ]);
    expect(story.subtasks[0]!.description).toContain(`Imported from work-tracker task \`${TASK_A}\``);
    expect(story.subtasks[0]!.description).toContain("- [x] ran");
    expect(story.subtasks[1]!.description).toContain(`Depended on, outside this task: \`${OTHER_STORY.slice(0, 8)}\` (story)`);
    expect(tasks.get(EPIC)!.labels).toEqual([TAG, epicLabel.id]);
    expect(tasks.get(OTHER_EPIC)!.status).toBe("done");
    expect(tasks.get(OTHER_STORY)!.status).toBe("cancelled");
  });

  it("keeps each item's own history with its writers and times, an old task's on its story marked with its subtask, and comments with the work log and links", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    expect(await store.history(EPIC)).toEqual([{ taskId: EPIC, action: "created", changes: [{ field: "title", from: null, to: "The epic" }], actor: "planner", at: "2026-11-01T00:00:00.000Z" }]);
    expect((await store.history(STORY)).map(({ action, changes, actor, at }) => [action, changes[0]!.field, actor, at])).toEqual([
      ["created", "title", "planner", "2026-11-02T00:00:00.000Z"],
      ["created", "s1.title", "planner", "2026-11-02T01:00:00.000Z"],
      ["created", "s2.title", "planner", "2026-11-02T02:00:00.000Z"],
      ["updated", "status", null, "2026-11-04T00:00:00.000Z"],
    ]);
    expect(await store.comments(STORY)).toEqual([
      { id: "c0000000-0000-4000-8000-000000000002", taskId: STORY, author: "agent-1", body: "Opened the PR.\n\nLinks:\n- https://example.com/pull/1", createdAt: "2026-11-02T12:00:00.000Z" },
      { id: "c0000000-0000-4000-8000-000000000003", taskId: STORY, author: "agent-1", body: `On subtask s1 (work-tracker task \`${TASK_A.slice(0, 8)}\`):\n\nStep done.`, createdAt: "2026-11-02T13:00:00.000Z" },
      { id: "c0000000-0000-4000-8000-000000000001", taskId: STORY, author: null, body: "A question", createdAt: "2026-11-03T00:00:00.000Z" },
    ]);
  });

  it("changes nothing and adds nothing when run again", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    const before = { version: version(store), tasks: JSON.stringify((await store.tasks()).all()), history: await store.history(STORY), comments: await store.comments(STORY) };
    const again = importWorkTracker(store.db, source());
    expect(again.tasks).toEqual({ created: 0, updated: 0, unchanged: 4 });
    expect(again.labels).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(again.added).toEqual({ comments: 0, history: 0 });
    expect(again.leftAlone).toEqual([]);
    expect({ version: version(store), tasks: JSON.stringify((await store.tasks()).all()), history: await store.history(STORY), comments: await store.comments(STORY) }).toEqual(before);
  });

  it("updates what it copied when the old tracker changed, adding only the new history and comments", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    const changed = source();
    changed.items.find((each) => each.id === STORY)!.title = "Renamed";
    changed.detail[STORY]!.history.push({ item: STORY, action: "updated", changes: [{ field: "title", from: "The story", to: "Renamed" }], at: "2026-11-05T00:00:00.000Z", claimedBy: "person", overrode: [] });
    changed.detail[STORY]!.comments.push({ id: "c0000000-0000-4000-8000-000000000009", item: STORY, author: null, at: "2026-11-05T00:00:00.000Z", body: "Later" });
    const report = importWorkTracker(store.db, changed);
    expect(report.tasks).toEqual({ created: 0, updated: 1, unchanged: 3 });
    expect(report.added).toEqual({ comments: 1, history: 1 });
    expect((await store.tasks()).get(STORY)!.title).toBe("Renamed");
    expect((await store.history(STORY)).length).toBe(5);
  });

  it("never overwrites a task made in waypoint, nor one changed there since it was copied, and lists a short id that no longer names its item", async () => {
    const store = fresh();
    const native = await store.createTask({ title: "Made in waypoint" }, "person");
    const clashing = source();
    // An old epic whose short id the native task's id also starts with.
    clashing.items.push(item({ id: `${native.id.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`, type: "epic", title: "Clashing epic" }));
    clashing.items.push(item({ id: native.id, type: "epic", title: "Same id" }));
    const report = importWorkTracker(store.db, clashing);
    expect(report.leftAlone).toEqual([{ id: native.id, why: "a task waypoint made itself has this id" }]);
    expect((await store.tasks()).get(native.id)!.title).toBe("Made in waypoint");
    expect(report.clashes.map((each) => each.shortId)).toEqual([native.id.slice(0, 8)]);

    await store.updateTask(STORY, { title: "Edited in waypoint" }, "person");
    const again = importWorkTracker(store.db, clashing);
    expect(again.leftAlone).toContainEqual({ id: STORY, why: "the task was changed in waypoint since the import wrote it" });
    expect((await store.tasks()).get(STORY)!.title).toBe("Edited in waypoint");
  });

  it("gives an old tag the label waypoint already has by its name", async () => {
    const store = fresh();
    const label = await store.createLabel({ name: "Waypoint" });
    const report = importWorkTracker(store.db, source());
    expect(report.labelsShared).toEqual([{ tag: "waypoint", label: label.id }]);
    expect((await store.tasks()).get(EPIC)!.labels[0]).toBe(label.id);
  });

  it("writes nothing on a dry run", async () => {
    const store = fresh();
    const report = importWorkTracker(store.db, source(), { dryRun: true });
    expect(report.tasks.created).toBe(4);
    expect((await store.tasks()).all()).toEqual([]);
    expect(version(store)).toBeUndefined();
  });

  it("makes a write the server decided before it decide again, so neither is lost", async () => {
    const store = new FakeStore();
    importWorkTracker(store.db, source());
    const renamed = source();
    renamed.items.find((each) => each.id === STORY)!.title = "Renamed";
    const hold = store.holdNextRead();
    const update = store.updateTask(STORY, { description: "Edited in waypoint" }, "person");
    await hold.read;
    importWorkTracker(store.db, renamed);
    hold.release();
    expect(await update).toMatchObject({ title: "Renamed", description: "Edited in waypoint" });
  });
});

describe("readWorkTracker", () => {
  it("reads every item, its history, comments and work log, and the tags, by GET alone", async () => {
    const data = source();
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      const path = new URL(url).pathname;
      const [, , id, what] = path.split("/");
      const body =
        path === "/items" ? { items: data.items }
        : path === "/tags" ? { tags: data.tags }
        : what === "history" ? { entries: data.detail[id!]!.history }
        : what === "comments" ? { comments: data.detail[id!]!.comments }
        : { entries: data.detail[id!]!.workLog };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const read = await readWorkTracker("http://tracker.test/", "secret", fetcher);
    expect(read).toEqual(data);
    expect(calls.every((call) => call.startsWith("GET http://tracker.test/"))).toBe(true);
    expect(calls.length).toBe(2 + 3 * data.items.length);
  });

  it("fails on an HTTP error, naming the path", async () => {
    const fetcher = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(readWorkTracker("http://tracker.test", "bad", fetcher)).rejects.toThrow("GET /items: HTTP 401");
  });
});
