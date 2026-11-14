import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.ts";
import { Store } from "./store.ts";
import { epicLabelId, IMPORT_ACTOR, importWorkTracker, readWorkTracker, removeWorkTrackerImport, statusOf, type OldHistoryEntry, type OldItem, type Source } from "./work-tracker.ts";

const EPIC = "e1e1e1e1-0000-4000-8000-000000000001";
const STORY = "51515151-0000-4000-8000-000000000002";
const OTHER_EPIC = "e2e2e2e2-0000-4000-8000-000000000003";
const OTHER_STORY = "52525252-0000-4000-8000-000000000004";
const TASK_A = "7a7a7a7a-0000-4000-8000-000000000005";
const TASK_B = "7b7b7b7b-0000-4000-8000-000000000006";
const TAG = "7a900000-0000-4000-8000-000000000007";
const STORY_2 = "53535353-0000-4000-8000-000000000008";
const TAG_2 = "7a900000-0000-4000-8000-000000000009";
const LONE_STORY = "54545454-0000-4000-8000-00000000000a";
const LONE_STORY_TASK = "7d7d7d7d-0000-4000-8000-00000000000b";
const LONE_TASK = "7c7c7c7c-0000-4000-8000-00000000000c";

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

/**
 * Two epics: the first with a story holding two tasks, one depending on the
 * other, and a second story depending on the first; the second with a closed
 * story the first story depends on. A story with no epic, holding a task, and
 * a task with no story.
 */
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
  const story2 = item({ id: STORY_2, type: "story", title: "Next story", parent: EPIC, dependsOn: [STORY], tags: [TAG_2], createdAt: "2026-11-02T03:00:00.000Z" });
  const otherEpic = item({ id: OTHER_EPIC, type: "epic", title: "Other epic", state: "closed", closedReason: "completed", status: "done" });
  const otherStory = item({ id: OTHER_STORY, type: "story", title: "Other story", parent: OTHER_EPIC, state: "closed", closedReason: "not_planned", status: "backlog" });
  const loneStory = item({ id: LONE_STORY, type: "story", title: "Lone story", body: "On its own" });
  const loneStoryTask = item({ id: LONE_STORY_TASK, type: "task", title: "Lone step", parent: LONE_STORY });
  const loneTask = item({ id: LONE_TASK, type: "task", title: "Lone task", dependsOn: [EPIC, TASK_A] });
  const items = [epic, story, taskA, taskB, story2, otherEpic, otherStory, loneStory, loneStoryTask, loneTask];
  const detail: Source["detail"] = Object.fromEntries(items.map((each) => [each.id, { history: [created(each)], comments: [], workLog: [] }]));
  // An item's history holds what was written beneath it too.
  detail[STORY]!.history.push(created(taskA), { item: STORY, action: "updated", changes: [{ field: "status", from: "backlog", to: "ready" }], at: "2026-11-04T00:00:00.000Z", claimedBy: null, overrode: [] });
  detail[EPIC]!.history.push(...detail[STORY]!.history);
  detail[STORY]!.comments.push({ id: "c0000000-0000-4000-8000-000000000001", item: STORY, author: null, at: "2026-11-03T00:00:00.000Z", body: "A question" });
  detail[STORY]!.workLog.push({ id: "c0000000-0000-4000-8000-000000000002", item: STORY, author: "agent-1", at: "2026-11-02T12:00:00.000Z", body: "Opened the PR.", links: ["https://example.com/pull/1"] });
  detail[TASK_A]!.workLog.push({ id: "c0000000-0000-4000-8000-000000000003", item: TASK_A, author: "agent-1", at: "2026-11-02T13:00:00.000Z", body: "Step done.", links: [] });
  detail[LONE_STORY_TASK]!.comments.push({ id: "c0000000-0000-4000-8000-000000000004", item: LONE_STORY_TASK, author: "agent-2", at: "2026-11-02T14:00:00.000Z", body: "Alone." });
  return {
    items,
    tags: [
      { id: TAG, value: "waypoint", color: "#b03a6a", description: "The tracker", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: TAG_2, value: "self-hosted", color: "#3a6ab0", description: "Runs at home", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    ],
    detail,
  };
}

const fresh = () => new Store(new DatabaseSync(":memory:"));
const version = (store: Store) => (store.db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined)?.value;
const snapshot = async (store: Store) => ({
  version: version(store),
  tasks: JSON.stringify((await store.tasks()).all()),
  labels: JSON.stringify((await store.labels()).all()),
  history: await store.history(EPIC),
  comments: await store.comments(EPIC),
});

describe("statusOf", () => {
  it("maps a close as completed to done, as not planned to cancelled, and an open ready to backlog", () => {
    expect(statusOf({ status: "in_progress", state: "closed", closedReason: "completed" })).toBe("done");
    expect(statusOf({ status: "done", state: "closed", closedReason: "not_planned" })).toBe("cancelled");
    expect(statusOf({ status: "ready", state: "open", closedReason: null })).toBe("backlog");
    expect(statusOf({ status: "review", state: "open", closedReason: null })).toBe("review");
  });
});

describe("importWorkTracker", () => {
  it("makes each epic a task with its id, short id, timestamps and its stories' tags, and each of its stories a subtask of it", async () => {
    const store = fresh();
    const report = importWorkTracker(store.db, source());
    expect(report.tasks).toEqual({ created: 4, updated: 0, unchanged: 0 });
    expect(report.subtasks).toBe(3);
    expect(report.labels).toEqual({ created: 2, updated: 0, unchanged: 0 });
    expect(report.ownTasks).toEqual({ stories: [LONE_STORY.slice(0, 8)], tasks: [LONE_TASK.slice(0, 8)] });
    expect(report.clashes).toEqual([]);

    const tasks = await store.tasks();
    expect(tasks.all().map((task) => task.id).sort()).toEqual([EPIC, OTHER_EPIC, LONE_STORY, LONE_TASK].sort());
    expect((await store.labels()).all().map((label) => label.name).sort()).toEqual(["self-hosted", "waypoint"]);

    const epic = tasks.view(tasks.get(EPIC)!);
    expect(epic).toMatchObject({ shortId: EPIC.slice(0, 8), title: "The epic", status: "in_progress", dependsOn: [], labels: [TAG, TAG_2], assignee: null, criteria: [] });
    expect(epic.subtasks.map(({ id, title, status, dependsOn }) => ({ id, title, status, dependsOn }))).toEqual([
      { id: "s1", title: "The story", status: "backlog", dependsOn: [] },
      { id: "s2", title: "Next story", status: "backlog", dependsOn: ["s1"] },
    ]);
    expect(epic.subtasks[0]!.description).toBe(
      [
        "Story body",
        "",
        "---",
        "Acceptance criteria:",
        "- [x] works",
        "- [ ] documented",
        "",
        `Was story \`${STORY.slice(0, 8)}\` (\`${STORY}\`).`,
        "",
        `Depends on, outside this epic: \`${OTHER_STORY.slice(0, 8)}\` (story).`,
        "",
        "Tasks:",
        `- [x] First step (task \`${TASK_A.slice(0, 8)}\`)`,
        "  Do it",
        `- [ ] Second step (task \`${TASK_B.slice(0, 8)}\`, cancelled)`,
      ].join("\n"),
    );
    expect(tasks.get(OTHER_EPIC)!.subtasks).toMatchObject([{ id: "s1", title: "Other story", status: "cancelled" }]);
    expect(tasks.get(LONE_STORY)!.description).toBe(`On its own\n\n---\nTasks:\n- [ ] Lone step (task \`${LONE_STORY_TASK.slice(0, 8)}\`, backlog)`);
    expect(tasks.get(LONE_TASK)!.dependsOn).toEqual([EPIC]);
  });

  it("ticks, as met by the import when it was closed, each criterion left unmet on an item imported as done, and none on one still open", async () => {
    const given = source();
    const closedAt = "2026-11-05T00:00:00.000Z";
    const done = (fields: Partial<OldItem> & Pick<OldItem, "id">) =>
      item({ type: "epic", title: "Finished", state: "closed", closedReason: "completed", status: "done", acceptanceCriteria: ["shipped", "documented"], met: [{ criterion: "shipped", by: "approval-service", at: "2026-11-04T00:00:00.000Z" }], updatedAt: "2026-11-06T00:00:00.000Z", ...fields });
    const fromHistory = done({ id: "d1d1d1d1-0000-4000-8000-000000000011" });
    const fromField = done({ id: "d2d2d2d2-0000-4000-8000-000000000012", closedAt: "2026-11-05T12:00:00.000Z" });
    const unknown = done({ id: "d3d3d3d3-0000-4000-8000-000000000013" });
    const doneStory = done({ id: "d4d4d4d4-0000-4000-8000-000000000014", type: "story", parent: OTHER_EPIC });
    const openStory = item({ id: "d5d5d5d5-0000-4000-8000-000000000015", type: "story", title: "Still open", parent: unknown.id });
    given.items.push(fromHistory, fromField, unknown, doneStory, openStory);
    given.detail[fromHistory.id] = { history: [created(fromHistory), { item: fromHistory.id, action: "updated", changes: [{ field: "state", from: "open", to: "closed" }], at: closedAt, claimedBy: null, overrode: [] }], comments: [], workLog: [] };
    const store = fresh();
    const report = importWorkTracker(store.db, given);
    expect(report.doneWithUnmetCriteria).toEqual([]);
    expect(report.criteriaTickedAtImport.sort()).toEqual(["d1d1d1d1", "d2d2d2d2", "d3d3d3d3", "d4d4d4d4"]);
    expect(report.doneWithOpenSubtasks).toEqual(["d3d3d3d3"]);

    const tasks = await store.tasks();
    const criteria = (id: string) => tasks.get(id)!.criteria;
    expect(criteria(fromHistory.id)).toEqual([
      { id: "c1", text: "shipped", met: true, metBy: "approval-service", metAt: "2026-11-04T00:00:00.000Z" },
      { id: "c2", text: "documented", met: true, metBy: IMPORT_ACTOR, metAt: closedAt },
    ]);
    expect(criteria(fromField.id)[1]).toMatchObject({ met: true, metBy: "import", metAt: "2026-11-05T12:00:00.000Z" });
    expect(criteria(unknown.id)[1]).toMatchObject({ met: true, metBy: "import", metAt: "2026-11-06T00:00:00.000Z" });
    // A done story shows its criteria met, as the import ticks them; an open one's stay unmet.
    expect(tasks.get(OTHER_EPIC)!.subtasks[1]!.description).toContain("- [x] shipped\n- [x] documented");
    expect(tasks.get(EPIC)!.subtasks[0]!.description).toContain("- [ ] documented");

    // Editable, as any done task with its criteria met is.
    await store.updateTask(fromHistory.id, { title: "Finished, renamed" }, "person");
    expect((await store.tasks()).get(fromHistory.id)!.title).toBe("Finished, renamed");

    // And a second run changes nothing.
    const again = importWorkTracker(store.db, given);
    expect(again.tasks.created + again.tasks.updated).toBe(0);
    expect(again.added).toEqual({ comments: 0, history: 0 });
  });

  it("puts each story's and old task's history and comments on its epic's task, marked with the subtask, keeping writers, times and links", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    expect((await store.history(EPIC)).map(({ action, changes, actor, at }) => [action, changes[0]!.field, actor, at])).toEqual([
      ["created", "title", "planner", "2026-11-01T00:00:00.000Z"],
      ["created", "s1.title", "planner", "2026-11-02T00:00:00.000Z"],
      ["created", `s1.${TASK_A.slice(0, 8)}.title`, "planner", "2026-11-02T01:00:00.000Z"],
      ["created", `s1.${TASK_B.slice(0, 8)}.title`, "planner", "2026-11-02T02:00:00.000Z"],
      ["created", "s2.title", "planner", "2026-11-02T03:00:00.000Z"],
      ["updated", "s1.status", null, "2026-11-04T00:00:00.000Z"],
    ]);
    const story = `On subtask s1 (story \`${STORY.slice(0, 8)}\``;
    expect(await store.comments(EPIC)).toEqual([
      { id: "c0000000-0000-4000-8000-000000000002", taskId: EPIC, author: "agent-1", body: `${story}):\n\nOpened the PR.\n\nLinks:\n- https://example.com/pull/1`, createdAt: "2026-11-02T12:00:00.000Z" },
      { id: "c0000000-0000-4000-8000-000000000003", taskId: EPIC, author: "agent-1", body: `${story}, task \`${TASK_A.slice(0, 8)}\`):\n\nStep done.`, createdAt: "2026-11-02T13:00:00.000Z" },
      { id: "c0000000-0000-4000-8000-000000000001", taskId: EPIC, author: null, body: `${story}):\n\nA question`, createdAt: "2026-11-03T00:00:00.000Z" },
    ]);
    expect(await store.comments(LONE_STORY)).toMatchObject([{ author: "agent-2", body: `On task \`${LONE_STORY_TASK.slice(0, 8)}\`:\n\nAlone.` }]);
    expect((await store.history(LONE_STORY)).map((entry) => entry.changes[0]!.field)).toEqual(["title", `${LONE_STORY_TASK.slice(0, 8)}.title`]);
  });

  it("changes nothing and adds nothing when run again", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    const before = await snapshot(store);
    const again = importWorkTracker(store.db, source());
    expect(again.tasks).toEqual({ created: 0, updated: 0, unchanged: 4 });
    expect(again.labels).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(again.added).toEqual({ comments: 0, history: 0 });
    expect(again.leftAlone).toEqual([]);
    expect(await snapshot(store)).toEqual(before);
  });

  it("updates what it copied when the old tracker changed, adding only the new history and comments, and keeps each story's subtask id", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    const changed = source();
    changed.items.find((each) => each.id === STORY)!.title = "Renamed";
    changed.detail[STORY]!.history.push({ item: STORY, action: "updated", changes: [{ field: "title", from: "The story", to: "Renamed" }], at: "2026-11-05T00:00:00.000Z", claimedBy: "person", overrode: [] });
    changed.detail[STORY]!.comments.push({ id: "c0000000-0000-4000-8000-000000000009", item: STORY, author: null, at: "2026-11-05T00:00:00.000Z", body: "Later" });
    // A story the tracker gives first, though new to the import.
    changed.items.unshift(item({ id: "55555555-0000-4000-8000-000000000010", type: "story", title: "Earlier", parent: EPIC }));
    const report = importWorkTracker(store.db, changed);
    expect(report.tasks).toEqual({ created: 0, updated: 1, unchanged: 3 });
    expect(report.added).toEqual({ comments: 1, history: 1 });
    expect((await store.tasks()).get(EPIC)!.subtasks.map(({ id, title }) => [id, title])).toEqual([["s3", "Earlier"], ["s1", "Renamed"], ["s2", "Next story"]]);
    expect((await store.history(EPIC)).length).toBe(7);
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

    await store.updateTask(EPIC, { title: "Edited in waypoint" }, "person");
    const again = importWorkTracker(store.db, clashing);
    expect(again.leftAlone).toContainEqual({ id: EPIC, why: "the task was changed in waypoint since the import wrote it" });
    expect((await store.tasks()).get(EPIC)!.title).toBe("Edited in waypoint");
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
    renamed.items.find((each) => each.id === EPIC)!.title = "Renamed";
    const hold = store.holdNextRead();
    const update = store.updateTask(EPIC, { description: "Edited in waypoint" }, "person");
    await hold.read;
    importWorkTracker(store.db, renamed);
    hold.release();
    expect(await update).toMatchObject({ title: "Renamed", description: "Edited in waypoint" });
  });
});

/** What an import before 0.6.0 left: a story as a task of its own, carrying its epic's `epic:` label, with a comment and history. */
function importedTheOldWay(store: Store): void {
  const track = (kind: string, key: string, value: string) => store.db.prepare("INSERT INTO work_tracker_import (kind, key, value) VALUES (?, ?, ?)").run(kind, key, value);
  const label = { id: epicLabelId(EPIC), name: `epic:${EPIC.slice(0, 8)}`, color: "#808080", description: "The epic", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
  store.db.prepare("INSERT INTO labels (id, record) VALUES (?, ?)").run(label.id, JSON.stringify(label));
  track("label", label.id, JSON.stringify(label));
  const story = { id: STORY, title: "The story", description: "", status: "backlog", dependsOn: [], subtasks: [], criteria: [], labels: [TAG, label.id], assignee: null, verification: null, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" };
  store.db.prepare("INSERT INTO tasks (id, record) VALUES (?, ?)").run(STORY, JSON.stringify(story));
  track("task", STORY, JSON.stringify(story));
  track("subtask", TASK_A, `${STORY}/s1`);
  store.db.prepare("INSERT INTO task_history (task_id, record) VALUES (?, ?)").run(STORY, JSON.stringify({ taskId: STORY, action: "created", changes: [], actor: "planner", at: story.createdAt }));
  track("history", "old-key", STORY);
  store.db.prepare("INSERT INTO comments (id, task_id, record) VALUES (?, ?, ?)").run("c-old", STORY, JSON.stringify({ id: "c-old", taskId: STORY, author: null, body: "Old", createdAt: story.createdAt }));
}

describe("removeWorkTrackerImport", () => {
  it("deletes what an import of either shape wrote, and nothing made in waypoint", async () => {
    const store = fresh();
    importWorkTracker(store.db, source());
    importedTheOldWay(store);
    expect(importWorkTracker(store.db, source()).stale).toEqual([STORY.slice(0, 8)]);
    const kept = await store.createTask({ title: "Made in waypoint", labels: [TAG] }, "person");
    const plain = await store.createTask({ title: "Also made in waypoint", dependsOn: [EPIC] }, "person");
    await store.createComment(plain.id, "Mine", "person");
    const ownLabel = await store.createLabel({ name: "mine" });
    const sameId = await store.createTask({ title: "Made in waypoint, an old id" }, "person");
    const given = source();
    given.items.push(item({ id: sameId.id, type: "epic", title: "Same id" }));

    const dry = removeWorkTrackerImport(store.db, given, { dryRun: true });
    expect((await store.tasks()).all().length).toBe(8);

    const report = removeWorkTrackerImport(store.db, given);
    expect(report).toEqual({ ...dry, dryRun: false });
    expect(report.removed).toEqual({ tasks: 5, comments: 5, history: 12, labels: 2 });
    expect(report.leftAlone).toEqual([sameId.id]);
    expect(report.labelsKept).toEqual([{ id: TAG, name: "waypoint", tasks: [kept.id] }]);

    const tasks = await store.tasks();
    expect(tasks.all().map((task) => task.title).sort()).toEqual(["Also made in waypoint", "Made in waypoint", "Made in waypoint, an old id"]);
    expect((await store.comments(plain.id)).map((comment) => comment.body)).toEqual(["Mine"]);
    expect((await store.history(plain.id)).length).toBe(1);
    expect((await store.labels()).all().map((label) => label.id).sort()).toEqual([TAG, ownLabel.id].sort());
    expect(store.db.prepare("SELECT kind FROM work_tracker_import ORDER BY kind").all()).toEqual([{ kind: "label" }]);

    // Imported again, as new, and a second time changing nothing.
    const imported = importWorkTracker(store.db, source());
    expect(imported.tasks).toEqual({ created: 4, updated: 0, unchanged: 0 });
    expect(imported.added).toEqual({ comments: 4, history: 11 });
    expect(imported.stale).toEqual([]);
    expect((await store.tasks()).get(plain.id)!.dependsOn).toEqual([EPIC]);
    const before = await snapshot(store);
    const again = importWorkTracker(store.db, source());
    expect(again.tasks).toEqual({ created: 0, updated: 0, unchanged: 4 });
    expect(again.added).toEqual({ comments: 0, history: 0 });
    expect(await snapshot(store)).toEqual(before);
  });

  it("changes nothing when nothing was imported", async () => {
    const store = fresh();
    const report = removeWorkTrackerImport(store.db, source());
    expect(report.removed).toEqual({ tasks: 0, comments: 0, history: 0, labels: 0 });
    expect(version(store)).toBeUndefined();
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
