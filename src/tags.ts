import { randomUUID } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import type { TagDraftSchema, TagPatchSchema, TagSchema } from "./schema.ts";

export type Tag = z.infer<typeof TagSchema>;
export type TagDraft = z.infer<typeof TagDraftSchema>;
export type TagPatch = z.infer<typeof TagPatchSchema>;

/** A tag value already taken by another tag, case-insensitively. */
export class TagTakenError extends Error {
  readonly tag: string;

  constructor(taken: Tag) {
    super(`another tag already has the value "${taken.value}": ${taken.id}`);
    this.tag = taken.id;
  }
}

/** Every tag as one read saw it. */
export class Tags {
  private readonly byId: Map<string, Tag>;

  constructor(tags: Tag[]) {
    this.byId = new Map(tags.map((tag) => [tag.id, tag]));
  }

  all(): Tag[] {
    return [...this.byId.values()].sort((a, b) => a.value.localeCompare(b.value));
  }

  get(id: string): Tag | undefined {
    return this.byId.get(id);
  }

  /** The tag `ref` names: its id, or else its value in any case. */
  find(ref: string): Tag | undefined {
    const value = ref.trim().toLowerCase();
    return this.byId.get(ref) ?? [...this.byId.values()].find((tag) => tag.value.toLowerCase() === value);
  }

  create(draft: TagDraft, now = new Date().toISOString()): Tag {
    const tag = { id: randomUUID(), ...draft, createdAt: now, updatedAt: now };
    this.checkFree(tag);
    return tag;
  }

  patched(current: Tag, patch: TagPatch, now = new Date().toISOString()): Tag {
    const next = { ...current, ...patch, updatedAt: now };
    this.checkFree(next);
    return next;
  }

  /** Throws TagTakenError when another tag holds `tag`'s value, in any case. */
  private checkFree(tag: Tag): void {
    const value = tag.value.toLowerCase();
    const taken = [...this.byId.values()].find(
      (other) => other.id !== tag.id && other.value.toLowerCase() === value,
    );
    if (taken) throw new TagTakenError(taken);
  }
}
