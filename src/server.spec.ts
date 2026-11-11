import { afterEach, describe, expect, it, vi } from "vitest";
import { start, type Running } from "./server.ts";

const ADMIN = "admin-token";
const headers = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

let running: Running | undefined;
afterEach(() => {
  running?.close();
  running = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const call = (path: string, init: RequestInit = {}) =>
  running!.api.fetch(new Request(`http://local${path}`, { ...init, headers }));

/** A queued story beneath an epic, by the person. */
const queued = async () => {
  const epic = (await (await call("/items", { method: "POST", body: JSON.stringify({ type: "epic", title: "E" }) })).json()) as { id: string };
  const story = (await (await call("/items", { method: "POST", body: JSON.stringify({ type: "story", title: "S", parent: epic.id }) })).json()) as { id: string };
  expect((await call(`/items/${story.id}`, { method: "PATCH", body: JSON.stringify({ queued: true }) })).status).toBe(200);
  return story.id;
};

describe("start", () => {
  it("with no worker-service, leaves queued items waiting, refuses a start with 503, and calls nothing out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    running = start({ db: ":memory:", uiUrl: "http://ui.example", adminToken: ADMIN });
    const story = await queued();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    const queue = (await (await call("/queue")).json()) as { running: unknown[]; queued: { item: { id: string }; state: string }[]; last: unknown };
    expect(queue.running).toEqual([]);
    expect(queue.queued.map((each) => [each.item.id, each.state])).toEqual([[story, "next"]]);
    expect(queue.last).toBeNull();
    expect((await call(`/items/${story}/assignment`, { method: "POST" })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with worker-service, asks it for an agent for the queued item on the dispatcher's timer", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ws-token");
        if (init?.method === "POST") return Response.json({ id: "00000000-0000-4000-8000-00000000000a", name: "implementer-00000000", state: "waiting", why: "queued" }, { status: 202 });
        return Response.json({ requests: [] });
      }),
    );
    running = start({ db: ":memory:", uiUrl: "http://ui.example", adminToken: ADMIN, workers: { url: "http://ws.example", token: "ws-token" }, dispatchEveryMs: 1000 });
    await queued();
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toContain("POST /fleet/requests");
    const { last } = (await (await call("/queue")).json()) as { last: { at: string } | null };
    expect(last).not.toBeNull();
  });
});
