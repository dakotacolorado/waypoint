// waypoint's page: the board, a task, and a form for a new one, over the API.
// Every element is made with `h`, which sets text, never HTML, so nothing a task says is run.

import { LETTERS, MARK_PIXEL_SVG, MARK_SVG, STATUSES, SUMMARY, TAGLINE } from "./banner.js";

const OPEN = STATUSES.filter((status) => status !== "cancelled");
const CLOSED = ["done", "cancelled"];
const TOKEN_KEY = "waypoint.token";

const main = document.getElementById("main");
const signout = document.getElementById("signout");

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

const token = () => localStorage.getItem(TOKEN_KEY);

/** Who made a write; null is the environment's admin token, which has no name. */
const who = (actor) => actor ?? "env admin token";

/** Where this page is served, as `https://host:8444/`: the base of the API and the MCP server too. */
const base = () => `${location.origin}${location.pathname}`;

/** One of the server's own SVG constants as an element: never anything a task says. */
const svg = (source) => document.importNode(new DOMParser().parseFromString(source, "image/svg+xml").documentElement, true);

/** The block-letter name with the pixel mark beside it. */
function wordmark() {
  return h("a", { class: "wordmark", href: "#/", "aria-label": "waypoint" }, h("pre", { "aria-hidden": "true" }, LETTERS), svg(MARK_PIXEL_SVG));
}

document.querySelector("header .brand").prepend(svg(MARK_SVG));

function landing() {
  return h(
    "div",
    { class: "landing" },
    wordmark(),
    h("p", { class: "tagline" }, TAGLINE),
    h("p", { class: "muted" }, SUMMARY),
    h(
      "p",
      { class: "endpoints muted" },
      "API ",
      h("code", {}, `${base()}tasks`),
      " · MCP ",
      h("code", {}, `${base()}mcp`),
      " · docs: ",
      h("a", { href: "./docs/api", target: "_blank" }, "API"),
      ", ",
      h("a", { href: "./docs/mcp", target: "_blank" }, "MCP"),
    ),
  );
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body ?? {};
  }
}

/** One API call, relative to this page, so it works wherever the server is mounted. */
async function api(method, path, body) {
  const res = await fetch(path.replace(/^\//, ""), {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    signIn("This browser's token is no longer one this server knows: sign in again.");
    throw new ApiError(401, { message: "That token is not one this server knows." });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Every page of a list operation, as one array. */
async function all(path, key) {
  const items = [];
  let next = null;
  do {
    const page = await api("GET", `${path}${path.includes("?") ? "&" : "?"}maxResults=500${next ? `&nextToken=${next}` : ""}`);
    items.push(...page[key]);
    next = page.nextToken;
  } while (next);
  return items;
}

const when = (iso) => new Date(iso).toLocaleString();
const label = (status) => status.replace("_", " ");
/** `el` holding `children` as `h` would make them. */
const fill = (el, ...children) => el.replaceChildren(...h("div", {}, ...children).childNodes);
const errorBox = () => h("div", { class: "error", role: "alert", hidden: true });
const show = (box, err) => {
  box.hidden = false;
  box.textContent = err.message;
};

/**
 * Runs `fn`, then redraws the page. If it is refused, `undo` puts the control that asked back to
 * the stored value, and `box` says why, in `explain`'s words when given.
 */
async function act(box, fn, { undo, explain } = {}) {
  try {
    await fn();
    route();
  } catch (err) {
    undo?.();
    show(box, explain && err instanceof ApiError ? { message: explain(err) } : err);
  }
}

/** Black or white, whichever reads better on `color` (#rrggbb): at least 4.5:1 for any colour. */
function inkOn(color) {
  const channel = (at) => {
    const value = parseInt(color.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000" : "#fff";
}
const tagStyle = (each) => `background:${each.color};color:${inkOn(each.color)}`;

const boardFor = (labelId) => `#/?label=${encodeURIComponent(labelId)}`;

/** A label as a chip that shows the board filtered to it. */
const chip = (each) => h("a", { class: "tag", href: boardFor(each.id), style: tagStyle(each), title: each.description || undefined }, each.name);

/** A card's label chips. The card is a link already, so each chip follows its own on click rather than nesting one. */
function chips(task, labels) {
  return task.labels
    .map((id) => labels.get(id))
    .filter(Boolean)
    .map((each) =>
      h(
        "span",
        {
          class: "tag",
          style: tagStyle(each),
          title: each.description || undefined,
          onclick: (e) => {
            e.preventDefault();
            location.hash = boardFor(each.id);
          },
        },
        each.name,
      ),
    );
}

/** How far a task's subtasks have got, naming cancelled ones apart from done. */
function progress(task) {
  if (!task.subtasks.length) return null;
  const done = task.subtasks.filter((sub) => sub.status === "done").length;
  const cancelled = task.subtasks.filter((sub) => sub.status === "cancelled").length;
  return `${done} done${cancelled ? `, ${cancelled} cancelled` : ""} of ${task.subtasks.length} subtasks`;
}

const SUBTASK_MARKS = { backlog: "○", in_progress: "◐", review: "◑", done: "✓", cancelled: "✕" };

/** A card's subtasks as text, since the card is a link: each changes on the task page. */
function subtaskList(task) {
  return h(
    "ul",
    { class: "card-subtasks" },
    task.subtasks.map((sub) =>
      h(
        "li",
        { class: `sub-${sub.status}` },
        h("span", { class: "mark", title: label(sub.status), "aria-hidden": "true" }, SUBTASK_MARKS[sub.status]),
        h("span", { class: "sr" }, `${label(sub.status)}: `),
        h("span", { class: sub.status === "cancelled" ? "struck" : "" }, sub.title),
        sub.blockedBy.length > 0 && h("span", { class: "badge blocked", title: `waits on ${sub.blockedBy.map((id) => `${id} ${task.subtasks.find((each) => each.id === id)?.title ?? ""}`).join("; ")}` }, "blocked"),
      ),
    ),
  );
}

/** The sign-in form, saying `why` when a token this browser had was refused. */
function signIn(why) {
  signout.hidden = true;
  const input = h("input", { type: "password", placeholder: "wp_…", style: "width:100%", autocomplete: "off", "aria-label": "Token" });
  const box = errorBox();
  if (why) show(box, { message: why });
  const form = h(
    "form",
    {
      class: "panel",
      onsubmit: async (event) => {
        event.preventDefault();
        const typed = input.value.trim();
        if (!typed) return show(box, { message: "Paste a token first." });
        // Checked here rather than through api(), whose answer to a 401 is to draw this form afresh.
        try {
          const res = await fetch("labels?maxResults=1", { headers: { authorization: `Bearer ${typed}` } });
          if (res.status === 401) return show(box, { message: "That token is not one this server knows." });
          if (!res.ok) return show(box, new ApiError(res.status, await res.json().catch(() => null)));
        } catch {
          return show(box, { message: "The server did not answer: is it running?" });
        }
        localStorage.setItem(TOKEN_KEY, typed);
        route();
      },
    },
    h("h2", {}, "Sign in"),
    h("p", { class: "muted" }, "Paste a token: the admin token waypoint printed when it first started, or one from waypoint token create. It stays in this browser."),
    input,
    box,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Sign in")),
  );
  main.replaceChildren(h("div", { class: "signin" }, landing(), form));
  input.focus();
}

const BOARD_KEY = "waypoint.board";
/** The board as the person last left it, filters and all. */
const lastBoard = () => sessionStorage.getItem(BOARD_KEY) ?? "#/";

async function board(params) {
  sessionStorage.setItem(BOARD_KEY, `#/${params.size ? `?${params}` : ""}`);
  // Older links carry `closed=1`.
  const cancelled = params.get("cancelled") === "1" || params.get("closed") === "1";
  const only = params.get("label") ?? "";
  const withSubtasks = params.get("subtasks") === "1";
  const readyOnly = params.get("ready") === "1";
  const unassigned = params.get("unassigned") === "1";
  const assignee = params.get("assignee") ?? "";
  const [tasks, labelList] = await Promise.all([all(`/tasks${cancelled ? "?includeCancelled=true" : ""}`, "tasks"), all("/labels", "labels")]);
  const labels = new Map(labelList.map((each) => [each.id, each]));
  const byId = new Map(tasks.map((each) => [each.id, each]));
  const named = (id) => (byId.has(id) ? `${byId.get(id).shortId} ${byId.get(id).title}` : id.slice(0, 8));
  const shown = tasks.filter(
    (task) =>
      (!only || task.labels.includes(only)) &&
      (!readyOnly || task.ready) &&
      (!unassigned || task.assignee === null) &&
      (!assignee || task.assignee === assignee),
  );
  const assignees = [...new Set([...tasks.map((task) => task.assignee).filter(Boolean), ...(assignee ? [assignee] : [])])].sort();
  /** The board with `changes` made to its filters; an empty value drops one. */
  const set = (changes) => {
    const next = new URLSearchParams(params);
    next.delete("closed");
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    location.hash = `#/?${next}`;
  };
  const UNASSIGNED = "\u0000unassigned";
  const filters = h(
    "div",
    { class: "filters" },
    labelList.length
      ? h("select", { "aria-label": "Label", onchange: (e) => set({ label: e.target.value }) }, h("option", { value: "" }, "Every label"), labelList.map((each) => h("option", { value: each.id, selected: each.id === only }, each.name)))
      : h("a", { href: "#/labels" }, "No labels yet: make one"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: cancelled, onchange: (e) => set({ cancelled: e.target.checked ? "1" : "" }) }), "Show cancelled"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: withSubtasks, onchange: (e) => set({ subtasks: e.target.checked ? "1" : "" }) }), "Show subtasks"),
    h(
      "select",
      { "aria-label": "Assignee", onchange: (e) => set(e.target.value === UNASSIGNED ? { assignee: "", unassigned: "1" } : { assignee: e.target.value, unassigned: "" }) },
      h("option", { value: "" }, "Anyone"),
      h("option", { value: UNASSIGNED, selected: unassigned }, "Unassigned"),
      assignees.map((name) => h("option", { value: name, selected: name === assignee }, name)),
    ),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: readyOnly, onchange: (e) => set({ ready: e.target.checked ? "1" : "" }) }), "Ready only"),
    h("span", { class: "muted" }, `${shown.length} of ${tasks.length} tasks · ${shown.filter((task) => task.ready).length} ready`),
  );
  const columns = (cancelled ? STATUSES : OPEN).map((status) => {
    const here = shown.filter((task) => task.status === status);
    return h(
      "section",
      { class: "column" },
      h("h2", {}, h("span", {}, label(status)), h("span", {}, here.length)),
      here.length === 0 && h("div", { class: "muted empty" }, "Nothing here"),
      here.map((task) =>
        h(
          "a",
          { class: "card", href: `#/task/${task.shortId}`, title: task.blockedBy.length ? `Waits on ${task.blockedBy.map(named).join("; ")}` : undefined },
          h("div", { class: "title" }, task.title),
          h(
            "div",
            { class: "meta" },
            h("span", {}, task.shortId),
            task.ready && h("span", { class: "badge ready" }, "ready"),
            task.blockedBy.length > 0 && h("span", { class: "badge blocked" }, `blocked by ${task.blockedBy.length}`),
            task.assignee && h("span", {}, `· ${task.assignee}`),
            progress(task) && h("span", {}, `· ${progress(task)}`),
            chips(task, labels),
          ),
          task.blockedBy.length > 0 && h("div", { class: "waits" }, `Waits on ${task.blockedBy.map(named).join("; ")}`),
          withSubtasks && task.subtasks.length > 0 && subtaskList(task),
        ),
      ),
    );
  });
  main.replaceChildren(filters, h("div", { class: `board cols-${columns.length}` }, columns));
}

const LIST_ITEM = /^\s*([-*]|\d+\.)\s+/;
const BLOCK_START = /^```|^\s*([-*]|\d+\.)\s+|^#{1,6}\s/;

/**
 * `text` as the part of Markdown people write in a comment: paragraphs, lists, headings, code,
 * bold, italic and links. Built with `h`, so nothing in it is ever HTML. `find` turns a word
 * that may be a task's short id into that task, so it links.
 */
function markdown(text, find) {
  const out = h("div", { class: "md" });
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.append(h("pre", {}, h("code", {}, code.join("\n"))));
    } else if (LIST_ITEM.test(line)) {
      const list = h(/^\s*\d/.test(line) ? "ol" : "ul", {});
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) list.append(h("li", {}, inline(lines[i].replace(LIST_ITEM, ""), find)));
      out.append(list);
    } else if (/^#{1,6}\s/.test(line)) {
      out.append(h("p", {}, h("strong", {}, inline(line.replace(/^#+\s*/, ""), find))));
      i++;
    } else if (!line.trim()) i++;
    else {
      const paragraph = [];
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !BLOCK_START.test(lines[i])); i++) paragraph.push(lines[i]);
      out.append(h("p", {}, paragraph.map((each, at) => [at > 0 && h("br"), inline(each, find)])));
    }
  }
  return out;
}

const INLINE =
  /`(?<code>[^`]+)`|\*\*(?<bold>.+?)\*\*|(?<![\w*])(?<mark>[*_])(?<italic>[^\s*_](?:.*?[^\s*_])?)\k<mark>(?![\w*])|\[(?<text>[^\]]+)\]\((?<href>https?:\/\/[^)\s]+)\)|(?<url>https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\b(?<ref>[0-9a-f]{8,})\b/g;

/** One line's inline Markdown, as nodes; a link is only ever http or https. */
function inline(text, find) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const { code, bold, italic, text: words, href, url, ref } = match.groups;
    parts.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (code !== undefined) parts.push(h("code", {}, code));
    else if (bold !== undefined) parts.push(h("strong", {}, inline(bold, find)));
    else if (italic !== undefined) parts.push(h("em", {}, inline(italic, find)));
    else if (href !== undefined) parts.push(h("a", { href, target: "_blank", rel: "noopener" }, words));
    else if (url !== undefined) parts.push(h("a", { href: url, target: "_blank", rel: "noopener" }, url));
    else {
      const task = find(ref);
      parts.push(task ? h("a", { href: `#/task/${task.shortId}`, title: task.title }, ref) : ref);
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** `value` as text no longer than `n`. */
const short = (value, n = 60) => {
  const text = String(value ?? "").replace(/\s+/g, " ");
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};
const quoted = (value) => (value === null || value === undefined || value === "" ? "nothing" : `"${short(value)}"`);
const without = (a, b) => a.filter((each) => !b.includes(each));

/** What changed in a list of subtasks or criteria, entry by entry. */
function entryChanges(from, to) {
  const was = new Map(from.map((each) => [each.id, each]));
  const out = [];
  for (const entry of to) {
    const before = was.get(entry.id);
    if (!before) {
      out.push(`+ ${entry.id} ${short(entry.title ?? entry.text, 40)}`);
      continue;
    }
    for (const key of ["title", "text", "description", "status", "met", "dependsOn"]) {
      if (!(key in entry) || JSON.stringify(before[key]) === JSON.stringify(entry[key])) continue;
      if (key === "status") out.push(`${entry.id} status ${label(before.status)} → ${label(entry.status)}`);
      else if (key === "met") out.push(`${entry.id} ${entry.met ? "met" : "unmet"}`);
      else if (key === "dependsOn") out.push(`${entry.id} after ${before.dependsOn.join(", ") || "nothing"} → ${entry.dependsOn.join(", ") || "nothing"}`);
      else out.push(`${entry.id} ${key} ${quoted(before[key])} → ${quoted(entry[key])}`);
    }
  }
  for (const entry of from) if (!to.some((each) => each.id === entry.id)) out.push(`− ${entry.id} ${short(entry.title ?? entry.text, 40)}`);
  return out;
}

/** One history change as what it was and what it became, or null for one that says nothing (an empty list created empty); `name` names a task or label id. */
function describe({ field, from, to }, name) {
  const each = (parts) => (parts.length ? `${field}: ${parts.join(field === "subtasks" || field === "criteria" ? "; " : ", ")}` : null);
  switch (field) {
    case "status":
      return `status: ${from ? label(from) : "nothing"} → ${to ? label(to) : "nothing"}`;
    case "dependsOn":
    case "labels": {
      const nameOf = name[field];
      return each([...without(to ?? [], from ?? []).map((id) => `+ ${nameOf(id)}`), ...without(from ?? [], to ?? []).map((id) => `− ${nameOf(id)}`)]);
    }
    case "subtasks":
    case "criteria":
      return each(entryChanges(from ?? [], to ?? []));
    default:
      return quoted(from) === quoted(to) ? null : `${field}: ${quoted(from)} → ${quoted(to)}`;
  }
}

/** Those of `value`'s fields that differ from `sub`'s, so a save sends only what was changed. */
const changed = (sub, value) => Object.fromEntries(Object.entries(value).filter(([key, each]) => JSON.stringify(each) !== JSON.stringify(sub[key])));

/**
 * A subtask's title and description, being written. Not a form, so it can sit inside one:
 * Enter in the title saves and Escape cancels.
 */
function subtaskEditor(sub, { onSave, onCancel, saveText = "Save" }) {
  const title = h("input", { value: sub?.title ?? "", placeholder: "Title", "aria-label": "Subtask title" });
  const description = h("textarea", { placeholder: "Description (optional)", "aria-label": "Subtask description" });
  description.value = sub?.description ?? "";
  const save = () => {
    if (!title.value.trim()) return title.focus();
    onSave({ title: title.value.trim(), description: description.value.trim() });
  };
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(), save();
  });
  const el = h(
    "div",
    {
      class: "editor",
      onkeydown: (e) => {
        if (e.key === "Escape") e.preventDefault(), onCancel();
      },
    },
    title,
    description,
    h("div", { class: "row" }, h("button", { type: "button", class: "primary", onclick: save }, saveText), h("button", { type: "button", onclick: onCancel }, "Cancel")),
  );
  return { el, focus: () => title.focus() };
}

/** The field a write from the task page just saved, said once on the redraw that follows it. */
let justSaved = null;

async function taskPage(ref) {
  const saved = justSaved;
  justSaved = null;
  const { task } = await api("GET", `/tasks/${encodeURIComponent(ref)}`);
  const [tasks, labelList, comments, history] = await Promise.all([
    all("/tasks?includeCancelled=true", "tasks"),
    all("/labels", "labels"),
    all(`/tasks/${task.id}/comments`, "comments"),
    all(`/tasks/${task.id}/history`, "entries"),
  ]);
  const byId = new Map(tasks.map((each) => [each.id, each]));
  const labels = new Map(labelList.map((each) => [each.id, each]));
  const find = (ref) => tasks.find((each) => each.shortId === ref || each.id.startsWith(ref));
  const link = (id) => {
    const other = byId.get(id);
    return other ? h("a", { href: `#/task/${other.shortId}` }, `${other.shortId} ${other.title}`, h("span", { class: "muted" }, ` · ${label(other.status)}`)) : h("span", { class: "muted" }, id.slice(0, 8));
  };
  const subtask = (id) => task.subtasks.find((sub) => sub.id === id);
  /** A refusal with what it names listed by text and title: the API names them by id alone. */
  const explain = (err) => {
    const { unmetCriteria = [], openSubtasks = [], blockedBy = [] } = err.body;
    const named = [
      ...unmetCriteria.map((id) => `${id} ${task.criteria.find((criterion) => criterion.id === id)?.text ?? ""}`),
      ...openSubtasks.map((id) => `${id} ${subtask(id)?.title ?? ""}`),
      ...blockedBy.map((id) => (byId.has(id) ? `${byId.get(id).shortId} ${byId.get(id).title}` : `${id} ${subtask(id)?.title ?? ""}`)),
    ];
    return [err.message, ...named.map((line) => `• ${line}`)].join("\n");
  };
  const box = errorBox();
  const labelBox = errorBox();
  const deleteTask = async () => {
    if (!confirm(`Delete task ${task.shortId} "${task.title}"? Its subtasks, criteria, comments and history go with it.`)) return;
    try {
      await api("DELETE", `/tasks/${task.id}`);
      location.hash = lastBoard();
    } catch (err) {
      const dependents = tasks.filter((other) => other.dependsOn.includes(task.id));
      show(box, { message: [err.message, ...(err.status === 409 ? dependents.map((other) => `• ${other.shortId} ${other.title}`) : [])].join("\n") });
    }
  };
  /** `undo` puts the control that asked back to the stored value if the change is refused. */
  const update = (changes, undo, where = box) => act(where, () => api("PATCH", `/tasks/${task.id}`, changes), { undo, explain });

  const head = h(
    "div",
    { class: "panel" },
    h("h1", {}, task.title),
    h(
      "div",
      { class: "meta" },
      h("span", {}, task.shortId),
      h("span", {}, `· ${label(task.status)}`),
      task.ready && h("span", { class: "badge ready" }, "ready"),
      task.blockedBy.length > 0 && h("span", { class: "badge blocked" }, `blocked by ${task.blockedBy.length}`),
    ),
    task.blockedBy.length > 0 && h("div", { class: "waits-on" }, "Waits on ", task.blockedBy.map((id, at) => [at > 0 && ", ", link(id)])),
    h(
      "div",
      { class: "row" },
      h("select", { "aria-label": "Status", onchange: (e) => update({ status: e.target.value }, () => (e.target.value = task.status)) }, STATUSES.map((status) => h("option", { value: status, selected: status === task.status }, label(status)))),
      CLOSED.includes(task.status)
        ? h("button", { onclick: () => update({ status: "backlog" }) }, "Reopen")
        : [h("button", { class: "primary", onclick: () => update({ status: "done" }) }, "Mark done"), h("button", { class: "quiet danger", onclick: () => update({ status: "cancelled" }) }, "Cancel task")],
      h("button", { onclick: () => editForm(task, tasks, labelList) }, "Edit"),
      h("button", { class: "danger", onclick: deleteTask }, "Delete"),
    ),
    box,
    h(
      "div",
      { class: "row" },
      h("span", { class: "muted", id: "assignee-label" }, "Assignee"),
      h("input", {
        value: task.assignee ?? "",
        placeholder: "no one",
        "aria-labelledby": "assignee-label",
        onchange: (e) =>
          act(
            box,
            async () => {
              await api("PATCH", `/tasks/${task.id}`, { assignee: e.target.value.trim() || null });
              justSaved = "assignee";
            },
            { undo: () => (e.target.value = task.assignee ?? ""), explain },
          ),
      }),
      saved === "assignee" && h("span", { class: "saved", role: "status" }, "Saved"),
    ),
    h(
      "div",
      { class: "row labels" },
      h("span", { class: "muted" }, "Labels"),
      task.labels
        .map((id) => labels.get(id))
        .filter(Boolean)
        .map((each) =>
          h(
            "span",
            { class: "chip" },
            chip(each),
            h("button", { type: "button", class: "quiet remove", "aria-label": `Take label ${each.name} off`, title: `Take ${each.name} off`, onclick: () => update({ labels: task.labels.filter((id) => id !== each.id) }, undefined, labelBox) }, "×"),
          ),
        ),
      labelList.length === 0
        ? h("a", { href: "#/labels" }, "No labels yet: make one")
        : labelList.some((each) => !task.labels.includes(each.id)) &&
            h(
              "select",
              { "aria-label": "Add a label", onchange: (e) => e.target.value && update({ labels: [...task.labels, e.target.value] }, () => (e.target.value = ""), labelBox) },
              h("option", { value: "" }, "Add a label…"),
              labelList.filter((each) => !task.labels.includes(each.id)).map((each) => h("option", { value: each.id }, each.name)),
            ),
    ),
    labelBox,
  );

  const description = h("div", { class: "panel" }, h("h2", {}, "Description"), task.description.trim() ? markdown(task.description, find) : h("div", { class: "muted" }, "Nothing written."));

  const met = task.criteria.filter((criterion) => criterion.met).length;
  // Every other entry gives only its id, so a tick or edit another caller makes meanwhile stands.
  const criteriaWith = (criterion, entry) => task.criteria.map((each) => (each.id === criterion.id ? { id: each.id, ...entry } : { id: each.id }));
  const criterionRow = (criterion) => {
    const li = h("li", { class: "criterion" });
    const rowBox = errorBox();
    const send = (list, undo) => update({ criteria: list }, undo, rowBox);
    const view = () =>
      fill(
        li,
        h(
          "label",
          { class: "check" },
          h("input", { type: "checkbox", checked: criterion.met, onchange: (e) => send(criteriaWith(criterion, { met: e.target.checked }), () => (e.target.checked = criterion.met)) }),
          h("span", {}, criterion.text, criterion.met && h("span", { class: "muted" }, ` · ${who(criterion.metBy)}, ${when(criterion.metAt)}`)),
        ),
        h(
          "span",
          { class: "actions" },
          h("button", { type: "button", class: "quiet", onclick: edit, "aria-label": `Edit criterion ${criterion.id}` }, "Edit"),
          h("button", { type: "button", class: "quiet", onclick: remove, "aria-label": `Remove criterion ${criterion.id}` }, "Remove"),
        ),
        rowBox,
      );
    const edit = () => {
      const input = h("input", { value: criterion.text, "aria-label": `Criterion ${criterion.id} text`, style: "flex:1" });
      const save = () => (input.value.trim() && input.value.trim() !== criterion.text ? send(criteriaWith(criterion, { text: input.value.trim() })) : view());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.preventDefault(), save();
        if (e.key === "Escape") e.preventDefault(), view();
      });
      fill(li, input, h("button", { type: "button", class: "primary", onclick: save }, "Save"), h("button", { type: "button", onclick: view }, "Cancel"), rowBox);
      input.focus();
    };
    const remove = () => {
      if (confirm(`Remove criterion ${criterion.id} "${criterion.text}"?`)) send(task.criteria.filter((each) => each.id !== criterion.id).map((each) => ({ id: each.id })));
    };
    view();
    return li;
  };
  const newCriterion = h("input", { placeholder: "New criterion", "aria-label": "New criterion", style: "flex:1" });
  const criterionBox = errorBox();
  const criteria = h(
    "div",
    { class: "panel" },
    h("h2", {}, `Acceptance criteria (${met}/${task.criteria.length})`),
    task.criteria.length === 0 ? h("div", { class: "muted" }, "None.") : h("ul", { class: "plain" }, task.criteria.map(criterionRow)),
    h(
      "form",
      {
        class: "row",
        onsubmit: (e) => {
          e.preventDefault();
          if (newCriterion.value.trim()) update({ criteria: [...task.criteria.map((each) => ({ id: each.id })), { text: newCriterion.value.trim() }] }, undefined, criterionBox);
        },
      },
      newCriterion,
      h("button", { type: "submit" }, "Add"),
    ),
    criterionBox,
  );

  const keep = task.subtasks.map((sub) => ({ id: sub.id }));
  // Every other entry gives only its id, so a change another caller makes to it meanwhile stands.
  const subtasksWith = (sub, entry) => task.subtasks.map((each) => (each.id === sub.id ? { id: each.id, ...entry } : { id: each.id }));
  const subtaskRow = (sub) => {
    const li = h("li", { class: "subtask" });
    const rowBox = errorBox();
    const send = (list, undo) => update({ subtasks: list }, undo, rowBox);
    const view = () =>
      fill(
        li,
        h(
          "select",
          { "aria-label": `Status of subtask ${sub.id}`, onchange: (e) => send(subtasksWith(sub, { status: e.target.value }), () => (e.target.value = sub.status)) },
          STATUSES.map((status) => h("option", { value: status, selected: status === sub.status }, label(status))),
        ),
        h("span", { class: sub.status === "cancelled" ? "struck" : "" }, h("span", { class: "muted" }, `${sub.id} `), sub.title),
        sub.dependsOn.length > 0 && h("span", { class: sub.blockedBy.length ? "badge blocked" : "muted" }, `depends on ${sub.dependsOn.join(", ")}`),
        h(
          "span",
          { class: "actions" },
          h("button", { type: "button", class: "quiet", onclick: edit, "aria-label": `Edit subtask ${sub.id}` }, "Edit"),
          h("button", { type: "button", class: "quiet", onclick: remove, "aria-label": `Remove subtask ${sub.id}` }, "Remove"),
        ),
        sub.description.trim() && h("div", { class: "muted body" }, sub.description),
        rowBox,
      );
    const edit = () => {
      const editor = subtaskEditor(sub, { onSave: (value) => send(subtasksWith(sub, changed(sub, value))), onCancel: view });
      li.replaceChildren(h("span", { class: "muted" }, sub.id), editor.el, rowBox);
      editor.focus();
    };
    const remove = () => {
      if (confirm(`Remove subtask ${sub.id} "${sub.title}"?`)) send(keep.filter((each) => each.id !== sub.id));
    };
    view();
    return li;
  };
  const adding = h("div", {});
  const addBox = errorBox();
  const addButton = () =>
    adding.replaceChildren(
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            const editor = subtaskEditor(null, {
              saveText: "Add",
              onSave: (value) => update({ subtasks: [...keep, value] }, undefined, addBox),
              onCancel: addButton,
            });
            adding.replaceChildren(editor.el, addBox);
            editor.focus();
          },
        },
        "Add subtask",
      ),
    );
  addButton();
  const subtasks = h(
    "div",
    { class: "panel" },
    h("h2", {}, `Subtasks${task.subtasks.length ? ` (${progress(task).replace(/ subtasks$/, "")})` : ""}`),
    task.subtasks.length === 0 ? h("div", { class: "muted" }, "None.") : h("ul", { class: "plain" }, task.subtasks.map(subtaskRow)),
    h("div", { class: "row" }, adding),
  );

  const comment = h("button", { type: "submit", disabled: true }, "Comment");
  const text = h("textarea", { placeholder: "Markdown: **bold**, *italic*, `code`, [a link](https://…), a task's short id", "aria-label": "Comment", oninput: () => (comment.disabled = !text.value.trim()) });
  const commentBox = errorBox();
  const talk = h(
    "div",
    { class: "panel" },
    h("h2", {}, "Comments"),
    comments.map((each) => h("div", { class: "note" }, h("div", { class: "who" }, `${who(each.author)} · ${when(each.createdAt)}`), markdown(each.body, find))),
    h(
      "form",
      { onsubmit: (e) => (e.preventDefault(), text.value.trim() && act(commentBox, () => api("POST", `/tasks/${task.id}/comments`, { body: text.value }))) },
      text,
      commentBox,
      h("div", { class: "row" }, comment),
    ),
  );

  const names = {
    dependsOn: (id) => (byId.has(id) ? `${byId.get(id).shortId} ${short(byId.get(id).title, 40)}` : id.slice(0, 8)),
    labels: (id) => labels.get(id)?.name ?? "a deleted label",
  };
  const side = h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Depends on"),
      task.dependsOn.length === 0 ? h("div", { class: "muted" }, "Nothing.") : h("ul", { class: "plain" }, task.dependsOn.map((id) => h("li", {}, link(id)))),
      (() => {
        const dependents = tasks.filter((other) => other.dependsOn.includes(task.id));
        return dependents.length > 0 && [h("h2", { style: "margin-top:12px" }, "Needed by"), h("ul", { class: "plain" }, dependents.map((other) => h("li", {}, link(other.id))))];
      })(),
    ),
    h(
      "div",
      { class: "panel" },
      h("details", {}, h("summary", {}, `History (${history.length})`), h("ul", { class: "plain" }, history.slice().reverse().map((entry) =>
        h("li", {}, h("div", { class: "who muted" }, `${entry.action} · ${who(entry.actor)} · ${when(entry.at)}`), entry.changes.map((change) => describe(change, names)).filter(Boolean).map((text) => h("div", { class: "change" }, text))),
      ))),
    ),
  );
  main.replaceChildren(h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, h("a", { href: lastBoard() }, "Board"), " / ", task.shortId), h("div", { class: "item" }, h("div", {}, head, description, criteria, subtasks, talk), side));
}

async function labelsPage() {
  const [labelList, tasks] = await Promise.all([all("/labels", "labels"), all("/tasks?includeCancelled=true", "tasks")]);
  const carrying = (each) => tasks.filter((task) => task.labels.includes(each.id)).length;
  const tasksWord = (n) => `${n} ${n === 1 ? "task" : "tasks"}`;
  /** Name, colour and description inputs, filled from `each`. */
  const inputs = (each) => {
    const name = h("input", { value: each?.name ?? "", placeholder: "Name", "aria-label": "Label name", required: true, maxlength: 40 });
    const color = h("input", { type: "color", value: each?.color ?? "#2f5bd3", "aria-label": "Label colour" });
    const description = h("input", { value: each?.description ?? "", placeholder: "What it is for (optional)", "aria-label": "Label description", maxlength: 500, style: "flex:1" });
    return { nodes: [name, color, description], value: () => ({ name: name.value.trim(), color: color.value, description: description.value.trim() }), focus: () => name.focus() };
  };
  const row = (each) => {
    const li = h("li", { class: "label-row" });
    const rowBox = errorBox();
    const view = () =>
      fill(
        li,
        chip(each),
        h("span", { class: "grow" }, each.description ? each.description : h("span", { class: "muted" }, "No description.")),
        h("a", { class: "muted", href: boardFor(each.id) }, tasksWord(carrying(each))),
        h(
          "span",
          { class: "actions" },
          h("button", { type: "button", class: "quiet", "aria-label": `Edit label ${each.name}`, onclick: edit }, "Edit"),
          h("button", { type: "button", class: "quiet", "aria-label": `Delete label ${each.name}`, onclick: remove }, "Delete"),
        ),
        rowBox,
      );
    const edit = () => {
      const form = inputs(each);
      fill(
        li,
        h(
          "form",
          {
            class: "row grow",
            onsubmit: (e) => (e.preventDefault(), act(rowBox, () => api("PATCH", `/labels/${each.id}`, form.value()))),
            onkeydown: (e) => e.key === "Escape" && (e.preventDefault(), view()),
          },
          form.nodes,
          h("button", { type: "submit", class: "primary" }, "Save"),
          h("button", { type: "button", onclick: view }, "Cancel"),
        ),
        rowBox,
      );
      form.focus();
    };
    const remove = () => {
      const n = carrying(each);
      if (confirm(`Delete label ${each.name}? ${n ? `${tasksWord(n)} ${n === 1 ? "carries" : "carry"} it and will lose it.` : "No task carries it."}`)) act(rowBox, () => api("DELETE", `/labels/${each.id}`));
    };
    view();
    return li;
  };
  const create = inputs(null);
  const box = errorBox();
  main.replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h1", {}, "Labels"),
      labelList.length === 0 ? h("p", { class: "muted" }, "No labels yet. A label groups tasks: the board filters by it.") : h("ul", { class: "plain" }, labelList.map(row)),
    ),
    h(
      "form",
      { class: "panel", onsubmit: (e) => (e.preventDefault(), act(box, () => api("POST", "/labels", create.value()))) },
      h("h2", {}, "New label"),
      h("div", { class: "row" }, create.nodes, h("button", { type: "submit", class: "primary" }, "Create")),
      box,
    ),
  );
}

/** A multi-select of `options`, each `[value, text]`, with `chosen` selected. */
const many = (name, options, chosen) => h("select", { multiple: true, "aria-label": name, size: Math.min(6, Math.max(2, options.length)) }, options.map(([value, text]) => h("option", { value, selected: chosen.includes(value) }, text)));
const picked = (select) => [...select.selectedOptions].map((option) => option.value);

function fields(task, tasks, labelList) {
  const title = h("input", { value: task?.title ?? "", style: "width:100%", required: true, "aria-label": "Title" });
  const description = h("textarea", { style: "min-height:160px", "aria-label": "Description" });
  description.value = task?.description ?? "";
  // A task's criteria are edited in place on its page; only a new task takes them here.
  const criteria = !task && h("textarea", { "aria-label": "Acceptance criteria, one a line" });
  const dependsOn = many("Depends on", tasks.filter((other) => other.id !== task?.id).map((other) => [other.id, `${other.shortId} ${other.title}`]), task?.dependsOn ?? []);
  const labels = many("Labels", labelList.map((each) => [each.id, each.name]), task?.labels ?? []);
  const lines = (area) => area.value.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    nodes: [
      h("label", {}, "Title"), title,
      h("label", {}, "Description"), description,
      criteria && [h("label", {}, "Acceptance criteria, one a line"), criteria],
      h("label", {}, "Depends on"), dependsOn,
      h("label", {}, "Labels"), labels,
    ],
    value: () => ({
      title: title.value,
      description: description.value,
      ...(criteria && { criteria: lines(criteria).map((text) => ({ text })) }),
      dependsOn: picked(dependsOn),
      labels: picked(labels),
    }),
  };
}

function editForm(task, tasks, labelList) {
  const form = fields(task, tasks, labelList);
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("PATCH", `/tasks/${task.id}`, form.value());
            location.hash = `#/task/${task.shortId}`;
            route();
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, `Edit ${task.shortId}`),
      form.nodes,
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Save"), h("a", { href: `#/task/${task.shortId}` }, "Cancel")),
    ),
  );
}

async function newTask() {
  const [tasks, labelList] = await Promise.all([all("/tasks", "tasks"), all("/labels", "labels")]);
  const form = fields(null, tasks, labelList);
  const subtasks = h("textarea", { "aria-label": "Subtasks, one a line" });
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const steps = subtasks.value.split("\n").map((line) => line.trim()).filter(Boolean).map((title) => ({ title }));
            const { task } = await api("POST", "/tasks", { ...form.value(), subtasks: steps });
            location.hash = `#/task/${task.shortId}`;
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, "New task"),
      form.nodes,
      h("label", {}, "Subtasks, one a line"),
      subtasks,
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Create"), h("a", { href: lastBoard() }, "Cancel")),
    ),
  );
}

async function route() {
  if (!token()) return signIn();
  signout.hidden = false;
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(search);
  try {
    const task = /^\/task\/(.+)$/.exec(path ?? "");
    if (task) await taskPage(decodeURIComponent(task[1]));
    else if (path === "/new") await newTask();
    else if (path === "/labels") await labelsPage();
    else await board(params);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    main.replaceChildren(h("div", { class: "panel error", role: "alert" }, err.message));
  }
}

signout.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  route();
});
window.addEventListener("hashchange", route);
route();
