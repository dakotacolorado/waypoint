import { describe, expect, it } from "vitest";
import type { HistoryEntry, WorkItemView } from "./domain.ts";

/**
 * Runs against a deployed stage: `INTEGRATION_WT_URL=... INTEGRATION_WT_TOKEN=... npm test`.
 * Writes; never point it at prod. Not `WT_URL`, which every worker session has, set to prod.
 */

const url = process.env.INTEGRATION_WT_URL?.replace(/\/$/, "");
const token = process.env.INTEGRATION_WT_TOKEN;

const call = (path: string, init?: RequestInit) =>
  fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

const json = async <T>(res: Response): Promise<T> => {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
};

describe.skipIf(!url || !token)("deployed stage", () => {
  it("serves health without a token", async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${url}/items`, { headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("round-trips an item through every operation", async () => {
    const created = await json<WorkItemView>(
      await call("/items", {
        method: "POST",
        body: JSON.stringify({
          title: `integration ${new Date().toISOString()}`,
          type: "epic",
          acceptanceCriteria: ["created", "read back", "deleted"],
        }),
      }),
    );
    expect(created.status).toBe("backlog");

    try {
      const read = await json<WorkItemView>(await call(`/items/${created.id}`));
      expect(read.title).toBe(created.title);
      expect(read.acceptanceCriteria).toHaveLength(3);

      const patched = await json<WorkItemView>(
        await call(`/items/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "review" }),
        }),
      );
      expect(patched.status).toBe("review");
      expect(patched.title).toBe(created.title);

      const { items } = await json<{ items: WorkItemView[] }>(await call("/items?status=review"));
      expect(items.map((item) => item.id)).toContain(created.id);

      expect(created.state).toBe("open");
      const closed = await json<WorkItemView>(
        await call(`/items/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed", closedReason: "not_planned" }),
        }),
      );
      expect(closed).toMatchObject({ state: "closed", closedReason: "not_planned", status: "review" });
      const open = await json<{ items: WorkItemView[] }>(await call("/items?state=open"));
      expect(open.items.map((item) => item.id)).not.toContain(created.id);
    } finally {
      expect((await call(`/items/${created.id}`, { method: "DELETE" })).status).toBe(204);
    }

    expect((await call(`/items/${created.id}`)).status).toBe(404);
  });

  it("tracks hierarchy and dependencies", async () => {
    const make = async (body: object) =>
      json<WorkItemView>(
        await call("/items", { method: "POST", body: JSON.stringify(body) }),
      );
    const epic = await make({ title: "int-epic", type: "epic" });
    const story = await make({ title: "int-story", type: "story", parent: epic.id });
    const upstream = await make({ title: "int-upstream", parent: story.id });
    const task = await make({ title: "int-task", parent: story.id, dependsOn: [upstream.id] });

    try {
      expect(task.blockedBy).not.toEqual([]);
      const read = await json<WorkItemView>(await call(`/items/${epic.id}`));
      expect(read.children).toEqual([story.id]);

      const skipping = await call("/items", {
        method: "POST",
        body: JSON.stringify({ title: "int-skipping", parent: epic.id }),
      });
      expect(skipping.status).toBe(400);
      await expect(skipping.json()).resolves.toEqual({
        error: "a task needs a story as its parent, not an epic",
      });

      // A parent with children cannot be removed.
      expect((await call(`/items/${epic.id}`, { method: "DELETE" })).status).toBe(409);

      const early = await call(`/items/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) });
      expect(early.status).toBe(409);
      await expect(early.json()).resolves.toMatchObject({ blockedBy: [upstream.id] });

      await json<WorkItemView>(
        await call(`/items/${upstream.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "done" }),
        }),
      );
      expect((await json<WorkItemView>(await call(`/items/${task.id}`))).blockedBy).toEqual([]);
      const started = await call(`/items/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) });
      expect(started.status).toBe(200);
    } finally {
      for (const item of [task, upstream, story, epic]) {
        await call(`/items/${item.id}`, { method: "DELETE" });
      }
    }
  });

  it("reads an epic done by itself as its stories finish and close", async () => {
    const make = async (body: object) =>
      json<WorkItemView>(await call("/items", { method: "POST", body: JSON.stringify(body) }));
    const patch = async (id: string, body: object) =>
      json<WorkItemView>(
        await call(`/items/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      );
    const epic = await make({ title: "int-selfdone-epic", type: "epic" });
    const story = await make({ title: "int-selfdone-story", type: "story", parent: epic.id });
    const done = await make({ title: "int-selfdone-done", parent: story.id, status: "done" });
    const later = await make({ title: "int-selfdone-later", parent: story.id });

    try {
      expect((await json<WorkItemView>(await call(`/items/${story.id}`))).status).toBe(
        "in_progress",
      );
      await call(`/items/${later.id}`, { method: "DELETE" });
      expect((await json<WorkItemView>(await call(`/items/${epic.id}`))).status).toBe("done");

      await patch(story.id, { state: "closed", closedReason: "completed" });
      expect((await json<WorkItemView>(await call(`/items/${epic.id}`))).status).toBe("done");
    } finally {
      for (const item of [later, done, story, epic]) {
        await call(`/items/${item.id}`, { method: "DELETE" });
      }
    }
  });

  it("records every write beneath an item, and keeps it past a delete", async () => {
    const claimed = { "Claimed-By": "integration" };
    const make = async (body: object) =>
      json<WorkItemView>(
        await call("/items", { method: "POST", headers: claimed, body: JSON.stringify(body) }),
      );
    const epic = await make({ title: "int-history-epic", type: "epic" });
    const story = await make({ title: "int-history-story", type: "story", parent: epic.id });
    const history = async (id: string) =>
      (await json<{ entries: HistoryEntry[] }>(await call(`/items/${id}/history`))).entries;

    try {
      await call(`/items/${story.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "renamed" }),
      });
      const entries = await history(epic.id);
      expect(entries.map((entry) => [entry.item, entry.action, entry.claimedBy])).toEqual([
        [epic.id, "created", "integration"],
        [story.id, "created", "integration"],
        [story.id, "updated", null],
      ]);
    } finally {
      await call(`/items/${story.id}`, { method: "DELETE", headers: claimed });
      await call(`/items/${epic.id}`, { method: "DELETE", headers: claimed });
    }

    expect((await history(story.id)).at(-1)).toMatchObject({
      action: "deleted",
      claimedBy: "integration",
    });
  });
});
