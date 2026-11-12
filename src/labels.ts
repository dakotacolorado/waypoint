import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "./domain.ts";

export interface Label {
  id: string;
  name: string;
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabelInput {
  name: string;
  color?: string;
  description?: string;
}

const DEFAULT_COLOR = "#808080";

/** Every label as one read saw it. */
export class Labels {
  private readonly byId: Map<string, Label>;

  constructor(labels: Label[]) {
    this.byId = new Map(labels.map((label) => [label.id, label]));
  }

  all(): Label[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The label `ref` names: its id, or its name in any case. Throws NotFoundError. */
  find(ref: string): Label {
    const name = ref.trim().toLowerCase();
    const label = this.byId.get(ref) ?? [...this.byId.values()].find((each) => each.name.toLowerCase() === name);
    if (!label) throw new NotFoundError(`no label ${ref}`);
    return label;
  }

  /** `refs` as label ids, each once. Throws ValidationError for one that names no label. */
  ids(refs: string[]): string[] {
    return [
      ...new Set(
        refs.map((ref) => {
          try {
            return this.find(ref).id;
          } catch {
            throw new ValidationError(`no label ${ref}: create it first`);
          }
        }),
      ),
    ];
  }

  create(input: LabelInput, now = new Date().toISOString()): Label {
    const label = { id: randomUUID(), name: input.name.trim(), color: input.color ?? DEFAULT_COLOR, description: input.description ?? "", createdAt: now, updatedAt: now };
    this.checkFree(label);
    return label;
  }

  updated(current: Label, patch: Partial<LabelInput>, now = new Date().toISOString()): Label {
    const next = { ...current, ...patch, ...(patch.name !== undefined && { name: patch.name.trim() }), updatedAt: now };
    this.checkFree(next);
    return next;
  }

  private checkFree(label: Label): void {
    const name = label.name.toLowerCase();
    const taken = [...this.byId.values()].find((other) => other.id !== label.id && other.name.toLowerCase() === name);
    if (taken) throw new ConflictError(`another label is named ${taken.name}: ${taken.id}`, { labelId: taken.id });
  }
}
