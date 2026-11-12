import { describe, expect, it } from "vitest";
import {
  BlockedError,
  Graph,
  GraphError,
  WorkItem,
  type Draft,
  type Type,
  type WorkItemProps,
} from "./domain.ts";
import { WorkItemStore } from "./store.ts";

const draft = (over: Partial<Draft> = {}): Draft => ({
  type: "task",
  title: "t",
  body: "",
  acceptanceCriteria: [],
  status: "backlog",
  parent: null,
  dependsOn: [],
  ...over,
});

const make = (over: Partial<Draft> = {}) => WorkItem.create(draft(over));

describe("WorkItem", () => {
  it("stamps an id and both timestamps on create", () => {
    const item = make();
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.updatedAt).toBe(item.createdAt);
  });

  it("is created open", () => {
    expect(make()).toMatchObject({ state: "open", closedReason: null });
  });

  it("moves state and status independently, and forgets the reason on reopening", () => {
    const item = make({ status: "in_progress" });
    const closed = item.patched({ state: "closed", closedReason: "not_planned" });
    expect(closed).toMatchObject({ status: "in_progress", closedReason: "not_planned" });
    expect(closed.patched({ status: "done" }).state).toBe("closed");
    expect(item.patched({ status: "done" }).state).toBe("open");

    const reopened = closed.patched({ state: "open" });
    expect(reopened).toMatchObject({ state: "open", closedReason: null, status: "in_progress" });
  });

  it("patches into a new item, leaving the original alone", () => {
    const base = WorkItem.create(draft({ title: "Original" }), null, "2026-01-01T00:00:00.000Z");
    const next = base.patched({ status: "review" }, null, "2026-02-02T00:00:00.000Z");
    expect(next).toMatchObject({ status: "review", title: "Original", id: base.id });
    expect(next.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(base.status).toBe("backlog");
  });
});

describe("Graph hierarchy", () => {
  it("derives children from the parent each child stores", () => {
    const epic = make({ type: "epic" });
    const a = make({ type: "story", parent: epic.id });
    const b = make({ type: "story", parent: epic.id });
    const graph = new Graph([epic, a, b]);

    expect(graph.childrenOf(epic.id).sort()).toEqual([a.id, b.id].sort());
    expect(graph.childrenOf(a.id)).toEqual([]);
    expect(graph.view(epic).children).toHaveLength(2);
  });

  const tree = () => {
    const epic = make({ type: "epic" });
    const story = make({ type: "story", parent: epic.id });
    const task = make({ type: "task", parent: story.id });
    return { epic, story, task, graph: new Graph([epic, story, task]) };
  };
  const refusal = (graph: Graph, item: WorkItem) => {
    try {
      graph.validate(item);
    } catch (err) {
      if (err instanceof GraphError) return err.message;
      throw err;
    }
    return null;
  };

  it("takes exactly the next type up as parent, and an epic none", () => {
    const { epic, story, task, graph } = tree();
    expect(refusal(graph, make({ type: "epic" }))).toBeNull();
    expect(refusal(graph, make({ type: "story", parent: epic.id }))).toBeNull();
    expect(refusal(graph, make({ type: "task", parent: story.id }))).toBeNull();

    const needs = (type: Type, parent: WorkItem | null) =>
      refusal(graph, make({ type, parent: parent?.id ?? null }));
    expect(needs("task", null)).toBe("a task needs a story as its parent");
    expect(needs("task", epic)).toBe("a task needs a story as its parent, not an epic");
    expect(needs("task", task)).toBe("a task needs a story as its parent, not a task");
    expect(needs("story", null)).toBe("a story needs an epic as its parent");
    expect(needs("story", story)).toBe("a story needs an epic as its parent, not a story");
    expect(needs("story", task)).toBe("a story needs an epic as its parent, not a task");
    for (const parent of [epic, story, task]) {
      expect(needs("epic", parent)).toBe("an epic has no parent");
    }
  });

  it("holds a move to the same rule as a create", () => {
    const { epic, story, task, graph } = tree();
    const moved = (item: WorkItem, parent: string | null) =>
      refusal(graph, item.patched({ parent }));
    expect(moved(task, epic.id)).toMatch(/needs a story/);
    expect(moved(task, null)).toMatch(/needs a story/);
    expect(moved(story, null)).toMatch(/needs an epic/);
    expect(moved(epic, story.id)).toBe("an epic has no parent");
  });

  it("refuses a re-type that leaves the item or its children at the wrong level", () => {
    const { epic, story, task, graph } = tree();
    const retyped = (item: WorkItem, type: Type, parent = item.parent) =>
      refusal(graph, item.patched({ type, parent }));
    expect(retyped(story, "epic")).toBe("an epic has no parent");
    expect(retyped(story, "epic", null)).toBe(
      "an epic cannot hold a task: a task needs a story as its parent",
    );
    expect(retyped(epic, "story")).toMatch(/needs an epic/);
    expect(retyped(task, "story")).toBe("a story needs an epic as its parent, not a story");

    const childless = make({ type: "story", parent: epic.id });
    const promoted = childless.patched({ type: "epic", parent: null });
    expect(refusal(new Graph([epic, childless]), promoted)).toBeNull();
  });

  it("rejects a missing parent, and itself as parent", () => {
    const item = make({ type: "task" });
    const graph = new Graph([item]);
    expect(() => graph.validate(make({ parent: "nope" }))).toThrow(/no item with id/);
    expect(() => graph.validate(new WorkItem({ ...item.toJSON(), parent: item.id }))).toThrow(
      /own parent/,
    );
  });
});

describe("Graph status", () => {
  const withChildren = (parent: Partial<Draft>, ...children: Draft["status"][]) => {
    const story = make({ type: "story", ...parent });
    const tasks = children.map((status) => make({ status, parent: story.id }));
    return new Graph([story, ...tasks]).status(story);
  };

  it("keeps the stored status while there are no children", () => {
    for (const status of ["backlog", "ready", "in_progress", "review", "done"] as const) {
      expect(withChildren({ status })).toBe(status);
    }
  });

  it("reads done when every child is done, whatever the parent stores", () => {
    expect(withChildren({ status: "ready" }, "done", "done")).toBe("done");
    expect(withChildren({ status: "backlog" }, "done")).toBe("done");
    expect(withChildren({ status: "done" }, "done", "review")).toBe("review");
  });

  it("reads review only when no child is backlog, ready or in_progress", () => {
    expect(withChildren({ status: "backlog" }, "review", "done")).toBe("review");
    expect(withChildren({ status: "backlog" }, "review", "review")).toBe("review");
    for (const unfinished of ["backlog", "ready", "in_progress"] as const) {
      expect(withChildren({ status: "review" }, "review", "done", unfinished)).toBe("in_progress");
    }
  });

  it("reads in_progress once anything has started, or finished beside unstarted work", () => {
    expect(withChildren({ status: "done" }, "done", "backlog")).toBe("in_progress");
    expect(withChildren({ status: "backlog" }, "done", "ready")).toBe("in_progress");
    expect(withChildren({ status: "backlog" }, "review", "ready")).toBe("in_progress");
    expect(withChildren({ status: "review" }, "in_progress")).toBe("in_progress");
  });

  it("reads ready when every child is ready, and backlog for any other unstarted mix", () => {
    expect(withChildren({ status: "done" }, "ready", "ready")).toBe("ready");
    expect(withChildren({ status: "done" }, "ready", "backlog")).toBe("backlog");
    expect(withChildren({ status: "ready" }, "backlog")).toBe("backlog");
  });

  it("derives from the children's derived status, to the top of the tree", () => {
    const epic = make({ type: "epic" });
    const story = make({ type: "story", parent: epic.id });
    const task = make({ status: "in_progress", parent: story.id });
    const graph = new Graph([epic, story, task]);
    expect(graph.status(epic)).toBe("in_progress");
    expect(graph.view(epic).status).toBe("in_progress");
  });

  it("reads the stored status exactly when the item has no children", () => {
    const story = make({ type: "story", status: "done" });
    const task = make({ status: "ready", parent: story.id });
    expect(new Graph([story, task]).view(story).status).toBe("ready");
    expect(new Graph([story]).view(story).status).toBe("done");
  });

  it("reads done to the top of the tree once the leaves are done, and leaves it as soon as one does", () => {
    const epic = make({ type: "epic" });
    const story = make({ type: "story", parent: epic.id });
    const task = make({ status: "done", parent: story.id });
    const graph = new Graph([epic, story, task]);
    expect(graph.status(story)).toBe("done");
    expect(graph.status(epic)).toBe("done");

    for (const [status, above] of [["review", "review"], ["in_progress", "in_progress"]] as const) {
      const moved = new Graph([epic, story, task.patched({ status })]);
      expect([moved.status(story), moved.status(epic)]).toEqual([above, above]);
    }
    const arrived = new Graph([epic, story, task, make({ status: "backlog", parent: story.id })]);
    expect([arrived.status(story), arrived.status(epic)]).toEqual(["in_progress", "in_progress"]);
  });

  it("unblocks a dependent on a parent only once the parent reads done", () => {
    const story = make({ type: "story" });
    const task = make({ status: "review", parent: story.id });
    const dependent = make({ dependsOn: [story.id] });
    expect(new Graph([story, task, dependent]).blockedBy(dependent)).toEqual([story.id]);

    const finished = new WorkItem({ ...task.toJSON(), status: "done" });
    expect(new Graph([story, finished, dependent]).blockedBy(dependent)).toEqual([]);
  });

  it("blocks a child by what any item above it depends on", () => {
    const upstream = make({ type: "epic" });
    const epic = make({ type: "epic" });
    const story = make({ type: "story", parent: epic.id, dependsOn: [upstream.id] });
    const task = make({ parent: story.id });
    const graph = new Graph([upstream, epic, story, task]);
    expect(graph.blockedBy(task)).toEqual([upstream.id]);
    expect(() => graph.checkStart(task, task.patched({ status: "in_progress" }))).toThrow(BlockedError);
  });

  it("derives from open children only, so a closed one stops holding the parent back", () => {
    const story = make({ type: "story" });
    const done = make({ status: "done", parent: story.id });
    const dropped = make({ status: "ready", parent: story.id }).patched({
      state: "closed",
      closedReason: "not_planned",
    });
    expect(new Graph([story, done, dropped]).status(story)).toBe("done");
  });

  it("treats a parent with no open children as one whose children are all done", () => {
    const closed = (parent: WorkItem) =>
      make({ status: "in_progress", parent: parent.id }).patched({
        state: "closed",
        closedReason: "not_planned",
      });
    const story = make({ type: "story" });
    expect(new Graph([story, closed(story)]).status(story)).toBe("done");
  });

  it("survives a stored parent cycle", () => {
    const a = make({ type: "story" });
    const b = make({ type: "story", parent: a.id });
    const looped = new WorkItem({ ...a.toJSON(), parent: b.id });
    expect(() => new Graph([looped, b]).status(looped)).not.toThrow();
  });
});

describe("Graph dependencies", () => {
  // Epics, which need no parent, so only the dependency rule is in play.
  const make = (over: Partial<Draft> = {}) => WorkItem.create(draft({ type: "epic", ...over }));

  it("reports blocked by each dependency not yet done, review included", () => {
    const building = make({ status: "in_progress" });
    const built = make({ status: "review" });
    const finished = make({ status: "done" });
    const item = make({ status: "ready", dependsOn: [building.id, built.id, finished.id] });
    expect(new Graph([building, built, finished, item]).blockedBy(item)).toEqual([building.id, built.id]);

    const done = (each: WorkItem) => new WorkItem({ ...each.toJSON(), status: "done" });
    expect(new Graph([done(building), done(built), finished, item]).blockedBy(item)).toEqual([]);
  });

  it("counts a dependency it cannot find as not built", () => {
    const item = make({ dependsOn: ["gone"] });
    expect(new Graph([item]).blockedBy(item)).toEqual(["gone"]);
  });

  it("stays blocked at every status while a dependency is unfinished", () => {
    const upstream = make({ status: "backlog" });
    for (const status of ["backlog", "ready", "in_progress", "review", "done"] as const) {
      const item = make({ status, dependsOn: [upstream.id] });
      expect(new Graph([upstream, item]).view(item)).toMatchObject({ blockedBy: [upstream.id] });
    }
  });

  describe("checkStart", () => {
    const upstream = make({ status: "review", title: "Upstream" });
    const item = make({ status: "ready", dependsOn: [upstream.id] });
    const graph = new Graph([upstream, item]);

    for (const status of ["in_progress", "review", "done"] as const) {
      it(`refuses a move to ${status}, naming each unfinished dependency`, () => {
        const refusal = (() => {
          try {
            graph.checkStart(item, item.patched({ status }));
          } catch (err) {
            return err as BlockedError;
          }
        })();
        expect(refusal).toBeInstanceOf(BlockedError);
        expect(refusal!.blockedBy).toEqual([upstream.id]);
        expect(refusal!.message).toContain(`${graph.shortId(upstream.id)} "Upstream" (review)`);
      });
    }

    it("refuses creating an item already started", () => {
      expect(() => graph.checkStart(null, make({ status: "in_progress", dependsOn: [upstream.id] }))).toThrow(
        BlockedError,
      );
    });

    it("lets a move back, or to ready, through", () => {
      expect(() => graph.checkStart(item, item.patched({ status: "backlog" }))).not.toThrow();
      const started = make({ status: "in_progress", dependsOn: [upstream.id] });
      expect(() => new Graph([upstream, started]).checkStart(started, started.patched({ status: "ready" }))).not.toThrow();
    });

    it("leaves work already started where it is, until its next move", () => {
      const started = make({ status: "in_progress", dependsOn: [upstream.id] });
      const g = new Graph([upstream, started]);
      expect(() => g.checkStart(started, started.patched({ title: "renamed" }))).not.toThrow();
      expect(() => g.checkStart(started, started.patched({ status: "review" }))).toThrow(BlockedError);
    });

    for (const closedReason of ["completed", "not_planned"] as const) {
      it(`lets a dependency closed as ${closedReason} through`, () => {
        const settled = new WorkItem({ ...upstream.toJSON(), state: "closed", closedReason });
        expect(() => new Graph([settled, item]).checkStart(item, item.patched({ status: "done" }))).not.toThrow();
      });
    }

    it("lets a done dependency through", () => {
      const finished = new WorkItem({ ...upstream.toJSON(), status: "done" });
      expect(() => new Graph([finished, item]).checkStart(item, item.patched({ status: "in_progress" }))).not.toThrow();
    });

    it("refuses a started status written to a blocked parent, its Start, and checks a child's move", () => {
      const parent = make({ dependsOn: [upstream.id] });
      const child = WorkItem.create(draft({ type: "story", parent: parent.id }));
      const g = new Graph([upstream, parent, child]);
      for (const status of ["in_progress", "done"] as const) {
        expect(() => g.checkStart(parent, parent.patched({ status }))).toThrow(BlockedError);
      }
      expect(() => g.checkStart(parent, parent.patched({ status: "backlog" }))).not.toThrow();
      expect(() => g.checkStart(child, child.patched({ status: "in_progress" }))).toThrow(BlockedError);
    });

    it("refuses a parent's Start for what blocks a child, even when the status written is the one stored", () => {
      const parent = make({ status: "in_progress" });
      const child = WorkItem.create(draft({ type: "story", parent: parent.id, dependsOn: [upstream.id] }));
      const g = new Graph([upstream, parent, child]);
      expect(() => g.checkStart(parent, parent.patched({ status: "in_progress" }), true)).toThrow(BlockedError);
      expect(() => g.checkStart(parent, parent.patched({ title: "renamed" }), false)).not.toThrow();
    });

    it("lets a status written to a parent already reading started through, since it moves only with its children", () => {
      const parent = make({ dependsOn: [upstream.id] });
      const child = WorkItem.create(draft({ type: "story", parent: parent.id, status: "in_progress" }));
      const g = new Graph([upstream, parent, child]);
      expect(() => g.checkStart(parent, parent.patched({ status: "done" }))).not.toThrow();
    });

    it("lets an unblocked parent's Start through", () => {
      const parent = make();
      const child = WorkItem.create(draft({ type: "story", parent: parent.id }));
      expect(() => new Graph([parent, child]).checkStart(parent, parent.patched({ status: "in_progress" }))).not.toThrow();
    });
  });

  describe("a parent's blockedBy", () => {
    const outside = make({ status: "backlog" });
    const epic = make();
    const story = (over: Partial<Draft> = {}) => WorkItem.create(draft({ type: "story", parent: epic.id, ...over }));
    const task = (parent: WorkItem, over: Partial<Draft> = {}) =>
      WorkItem.create(draft({ type: "task", parent: parent.id, ...over }));

    it("lists a dependency of an open story on an item outside the epic", () => {
      const waiting = story({ dependsOn: [outside.id] });
      const g = new Graph([outside, epic, waiting]);
      expect(g.blockedBy(epic)).toEqual([outside.id]);
      expect(g.view(epic)).toMatchObject({ blockedBy: [outside.id] });
    });

    it("lists a task's outside dependency on both its story and its epic", () => {
      const parent = story();
      const waiting = task(parent, { dependsOn: [outside.id] });
      const g = new Graph([outside, epic, parent, waiting]);
      expect(g.blockedBy(parent)).toEqual([outside.id]);
      expect(g.blockedBy(epic)).toEqual([outside.id]);
    });

    it("leaves out a dependency inside its own subtree, or on itself", () => {
      const first = story();
      const second = story({ dependsOn: [first.id] });
      const inner = task(first, { dependsOn: [epic.id] });
      const nephew = task(second, { dependsOn: [first.id, inner.id] });
      const g = new Graph([epic, first, second, inner, nephew]);
      expect(g.blockedBy(epic)).toEqual([]);
      expect(g.blockedBy(second)).toEqual([first.id, inner.id]);
    });

    it("takes nothing from a done or closed child, nor from what is beneath one", () => {
      const finished = story({ status: "done", dependsOn: [outside.id] });
      const dropped = story({ dependsOn: [outside.id] }).patched({ state: "closed", closedReason: "not_planned" });
      const closedStory = story().patched({ state: "closed", closedReason: "not_planned" });
      const reopened = task(closedStory, { dependsOn: [outside.id] });
      expect(new Graph([outside, epic, finished, dropped, closedStory, reopened]).blockedBy(epic)).toEqual([]);
    });

    it("empties once every blocking item is done or closed", () => {
      const other = make({ status: "in_progress" });
      const waiting = story({ dependsOn: [outside.id, other.id] });
      const settled = [
        new WorkItem({ ...outside.toJSON(), status: "done" }),
        other.patched({ state: "closed", closedReason: "completed" }),
      ];
      expect(new Graph([outside, other, epic, waiting]).blockedBy(epic)).toEqual([outside.id, other.id]);
      expect(new Graph([...settled, epic, waiting]).blockedBy(epic)).toEqual([]);
    });

    it("names each dependency once, its own and its children's", () => {
      const own = new WorkItem({ ...epic.toJSON(), dependsOn: [outside.id] });
      const waiting = story({ dependsOn: [outside.id] });
      expect(new Graph([outside, own, waiting]).blockedBy(own)).toEqual([outside.id]);
    });
  });

  it("reports finishing early while done before every dependency is done", () => {
    const upstream = make({ status: "in_progress" });
    const item = make({ status: "done", dependsOn: [upstream.id] });
    expect(new Graph([upstream, item]).finishedEarly(item)).toBe(true);

    const unsigned = new WorkItem({ ...upstream.toJSON(), status: "review" });
    expect(new Graph([unsigned, item]).finishedEarly(item)).toBe(true);

    const finished = new WorkItem({ ...upstream.toJSON(), status: "done" });
    expect(new Graph([finished, item]).finishedEarly(item)).toBe(false);

    const reopened = new WorkItem({ ...item.toJSON(), status: "review" });
    expect(new Graph([upstream, reopened]).finishedEarly(reopened)).toBe(false);
  });

  const closed = (item: WorkItem, closedReason: "completed" | "not_planned") =>
    new WorkItem({ ...item.toJSON(), state: "closed", closedReason });

  it("does not count a dependency closed as not planned as holding anything up", () => {
    const abandoned = closed(make({ status: "backlog" }), "not_planned");
    const building = make({ status: "in_progress" });
    const item = make({ status: "ready", dependsOn: [abandoned.id, building.id] });
    expect(new Graph([abandoned, building, item]).blockedBy(item)).toEqual([building.id]);

    const alone = make({ status: "ready", dependsOn: [abandoned.id] });
    expect(new Graph([abandoned, alone]).view(alone)).toMatchObject({ blockedBy: [] });
  });

  it("does not call work finished early for a dependency closed as not planned", () => {
    const abandoned = closed(make({ status: "in_progress" }), "not_planned");
    const item = make({ status: "done", dependsOn: [abandoned.id] });
    expect(new Graph([abandoned, item]).finishedEarly(item)).toBe(false);
  });

  it("counts a dependency closed as completed as settled, whatever its status", () => {
    const upstream = closed(make({ status: "backlog" }), "completed");
    const unstarted = make({ status: "ready", dependsOn: [upstream.id] });
    const finished = make({ status: "done", dependsOn: [upstream.id] });
    const graph = new Graph([upstream, unstarted, finished]);
    expect(graph.view(unstarted)).toMatchObject({ blockedBy: [] });
    expect(graph.finishedEarly(finished)).toBe(false);
  });

  it("holds the item up again once a closed dependency is reopened", () => {
    const upstream = make({ status: "backlog" });
    const unstarted = make({ status: "ready", dependsOn: [upstream.id] });
    const finished = make({ status: "done", dependsOn: [upstream.id] });
    const reopened = closed(upstream, "not_planned").patched({ state: "open" });
    const graph = new Graph([reopened, unstarted, finished]);
    expect(graph.blockedBy(unstarted)).toEqual([upstream.id]);
    expect(graph.finishedEarly(finished)).toBe(true);
  });

  it("is unblocked with no dependencies", () => {
    const item = make();
    expect(new Graph([item]).blockedBy(item)).toEqual([]);
  });

  it("rejects a dependency on itself or on a missing item", () => {
    const item = make();
    const graph = new Graph([item]);
    expect(() => graph.validate(new WorkItem({ ...item.toJSON(), dependsOn: [item.id] }))).toThrow(
      /depend on itself/,
    );
    expect(() => graph.validate(make({ dependsOn: ["nope"] }))).toThrow(/no item with id/);
  });

  it("rejects a direct cycle", () => {
    const a = make();
    const b = make({ dependsOn: [a.id] });
    const graph = new Graph([a, b]);
    // a depending on b closes a -> b -> a.
    expect(() => graph.validate(new WorkItem({ ...a.toJSON(), dependsOn: [b.id] }))).toThrow(
      /cycle/,
    );
  });

  it("rejects a cycle several hops away", () => {
    const a = make();
    const b = make({ dependsOn: [a.id] });
    const c = make({ dependsOn: [b.id] });
    const graph = new Graph([a, b, c]);
    expect(() => graph.validate(new WorkItem({ ...a.toJSON(), dependsOn: [c.id] }))).toThrow(
      /cycle/,
    );
  });

  it("allows a diamond, which is not a cycle", () => {
    const root = make();
    const left = make({ dependsOn: [root.id] });
    const right = make({ dependsOn: [root.id] });
    const graph = new Graph([root, left, right]);
    expect(() => graph.validate(make({ dependsOn: [left.id, right.id] }))).not.toThrow();
  });
});

describe("heldBy", () => {
  it("is the claimant of the write that moved the status to in_progress, or null if it said none", () => {
    expect(make({ status: "in_progress" }).heldBy).toBeNull();
    expect(WorkItem.create(draft({ status: "in_progress" }), "a").heldBy).toBe("a");
    expect(WorkItem.create(draft({ status: "review" }), "a").heldBy).toBeNull();
    const ready = make({ status: "ready" });
    expect(ready.patched({ status: "in_progress" }, "a").heldBy).toBe("a");
    expect(ready.patched({ status: "in_progress" }).heldBy).toBeNull();
  });

  it("is kept into review and by writes that leave the status, and re-set by a return", () => {
    const held = make({ status: "ready" }).patched({ status: "in_progress" }, "a");
    const review = held.patched({ status: "review" }, "b");
    expect(review.heldBy).toBe("a");
    expect(held.patched({ title: "x" }, "b").heldBy).toBe("a");
    expect(held.patched({ status: "in_progress" }, "b").heldBy).toBe("a");
    expect(review.patched({ status: "in_progress" }, "b").heldBy).toBe("b");
    expect(review.patched({ status: "in_progress" }).heldBy).toBeNull();
  });

  it("is cleared by backlog, ready, done or closing, and not restored by reopening", () => {
    const held = make({ status: "ready" }).patched({ status: "in_progress" }, "a");
    for (const status of ["backlog", "ready", "done"] as const) {
      expect(held.patched({ status }, "a").heldBy).toBeNull();
    }
    const closed = held.patched({ state: "closed", closedReason: "completed" }, "a");
    expect(closed.heldBy).toBeNull();
    expect(closed.patched({ state: "open" }, "a").heldBy).toBeNull();
    expect(held.patched({ status: "done" }).patched({ status: "in_progress" }, "c").heldBy).toBe("c");
  });

  it("is cleared on what closing a parent closes beneath it", () => {
    const story = make({ type: "story", status: "in_progress" });
    const task = make({ status: "ready", parent: story.id }).patched({ status: "in_progress" }, "a");
    const closed = story.patched({ state: "closed", closedReason: "not_planned" });
    const [beneath] = new Graph([story, task]).closedBeneath(story, closed);
    expect(beneath!.heldBy).toBeNull();
  });

  it("reads null while the status is derived, and the stored one once it is not", () => {
    const story = make({ type: "story", status: "ready" }).patched({ status: "in_progress" }, "a");
    const task = make({ status: "in_progress", parent: story.id });
    expect(new Graph([story, task]).view(story).heldBy).toBeNull();
    expect(new Graph([story]).view(story).heldBy).toBe("a");
  });
});

describe("Graph references", () => {
  it("names everything that would break on removal", () => {
    const epic = make({ type: "epic" });
    const child = make({ type: "story", parent: epic.id });
    const dependent = make({ dependsOn: [epic.id] });
    const graph = new Graph([epic, child, dependent]);

    expect(graph.referencesTo(epic.id).sort()).toEqual([child.id, dependent.id].sort());
    expect(graph.referencesTo(child.id)).toEqual([]);
  });
});

describe("WorkItemStore.itemFromRecord", () => {
  it("reads a record stored before type, parent, dependsOn and state existed", () => {
    const legacy = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "written under the old schema",
      body: "b",
      acceptanceCriteria: ["a"],
      status: "review",
      rank: 2000,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    const item = WorkItemStore.itemFromRecord(legacy);
    expect(item).toMatchObject({
      id: legacy.id,
      title: legacy.title,
      status: "review",
      type: "task",
      parent: null,
      dependsOn: [],
      state: "open",
      closedReason: null,
      heldBy: null,
    });
    // Reading it must not reintroduce rank, and must not break the graph.
    expect(item.toJSON()).not.toHaveProperty("rank");
    expect(new Graph([item]).blockedBy(item)).toEqual([]);
  });
});

describe("a record written before heldBy", () => {
  it("reads as held by no one, and a stored one is read back", () => {
    const base = {
      id: "an-id",
      title: "t",
      status: "in_progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(WorkItemStore.itemFromRecord(base).heldBy).toBeNull();
    expect(WorkItemStore.itemFromRecord({ ...base, heldBy: "a" }).heldBy).toBe("a");
    expect(WorkItemStore.itemFromRecord(base).reviewedBy).toBeNull();
    expect(WorkItemStore.itemFromRecord({ ...base, reviewedBy: "r" }).reviewedBy).toBe("r");
  });
});

describe("a record written before the rename", () => {
  it("reads todo as ready, and an unknown status as backlog", () => {
    const base = {
      id: "an-id",
      type: "task",
      title: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(WorkItemStore.itemFromRecord({ ...base, status: "todo" }).status).toBe("ready");
    expect(WorkItemStore.itemFromRecord({ ...base, status: "ready" }).status).toBe("ready");
    expect(WorkItemStore.itemFromRecord({ ...base, status: "nonsense" }).status).toBe("backlog");
    expect(WorkItemStore.itemFromRecord({ ...base }).status).toBe("backlog");
  });
});

describe("WorkItemStore, reading fields since dropped", () => {
  const sk = "11111111-1111-4111-8111-111111111111";
  const at = "2026-01-01T00:00:00.000Z";

  it("reads a stored status as given, ignoring a dropped doneAsLeaf", () => {
    const item = WorkItemStore.itemFromRecord({
      sk,
      title: "t",
      status: "review",
      doneAsLeaf: true,
      createdAt: at,
      updatedAt: at,
    });
    expect(item.toJSON()).not.toHaveProperty("doneAsLeaf");
    expect(new Graph([item]).status(item)).toBe("review");
  });

  it("ignores closedWith on an item", () => {
    const item = WorkItemStore.itemFromRecord({
      sk,
      title: "t",
      state: "closed",
      closedReason: "completed",
      closedWith: "22222222-2222-4222-8222-222222222222",
      createdAt: at,
      updatedAt: at,
    });
    expect(item.toJSON()).not.toHaveProperty("closedWith");
    expect(item).toMatchObject({ state: "closed", closedReason: "completed" });
  });

  it("drops them from the changes a history entry recorded", () => {
    const changes = [
      { field: "status", from: "review", to: "ready" },
      { field: "doneAsLeaf", from: true, to: false },
      { field: "closedWith", from: null, to: sk },
    ];
    const entry = WorkItemStore.historyFromRecord({ item: sk, action: "updated", changes, at });
    expect(entry.changes).toEqual([changes[0]]);
  });
});
