import { AgentRefusedError, type Agent, type AgentRequest, type Agents, type NewAgent, type NewRequest } from "./assignment.ts";

export const NOW = Date.parse("2026-11-06T12:00:00Z");

/** worker-service's admission as a test sets it: requests it was made, and whether it admits them at once. */
export class FakeFleet implements Agents {
  workers: Agent[] = [];
  made: NewAgent[] = [];
  requests: (AgentRequest & NewRequest)[] = [];
  /** Null admits a request at once; otherwise why it waits. */
  holdBack: string | null = null;
  refuse: string | null = null;
  /** Set to lose the next request's answer after it is recorded. */
  lose = false;

  get = async (id: string) => this.workers.find((worker) => worker.id === id) ?? null;
  named = async (name: string) => this.workers.find((worker) => worker.name === name && worker.state !== "retired") ?? null;
  retire = async (id: string) => void (this.workers.find((worker) => worker.id === id)!.state = "retired");
  make = async (agent: NewAgent) => {
    this.made.push(agent);
    const made: Agent = { id: `w-${this.made.length}`, name: agent.name, state: "working", status: "working" };
    this.workers.push(made);
    return made;
  };
  request = async (request: NewRequest) => {
    if (this.refuse) throw new AgentRefusedError(this.refuse, 400);
    const id = `${this.requests.length + 1}`.padStart(8, "0") + "-0000-4000-8000-000000000000";
    const made = { ...request, id, state: "waiting" as const, why: this.holdBack, workerId: null, createdAt: new Date(NOW).toISOString() };
    this.requests.push(made);
    if (this.holdBack === null) this.admit(id);
    if (this.lose) throw new TypeError("fetch failed");
    return { ...made };
  };
  requestOf = async (id: string) => this.requests.find((request) => request.id === id) ?? null;
  requestsFor = async (item: string) => this.requests.filter((request) => request.item === item);

  /** Starts the waiting request `id`, as admission would: the worker takes its id. */
  admit(id: string) {
    const request = this.requests.find((each) => each.id === id)!;
    Object.assign(request, { state: "started", why: null, workerId: id });
    this.workers.push({ id, name: `implementer-${id.slice(0, 8)}`, state: "working", status: "working" });
  }
}
