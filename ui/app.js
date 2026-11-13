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
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
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
function wordmark(small = false) {
  return h("a", { class: `wordmark${small ? " small" : ""}`, href: "#/", "aria-label": "waypoint" }, h("pre", { "aria-hidden": "true" }, LETTERS), svg(MARK_PIXEL_SVG));
}

document.querySelector("header .brand").prepend(svg(MARK_SVG));

function landing(small) {
  return h(
    "div",
    { class: "landing" },
    wordmark(small),
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
    route();
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
const errorBox = () => h("div", { class: "error", hidden: true });
const show = (box, err) => {
  box.hidden = false;
  box.textContent = err.message;
};

/** Runs `fn`, showing what refused it in `box`, then redraws the page. */
async function act(box, fn) {
  try {
    await fn();
    route();
  } catch (err) {
    show(box, err);
  }
}

function chips(task, labels) {
  return task.labels.map((id) => labels.get(id)).filter(Boolean).map((each) => h("span", { class: "tag", style: `background:${each.color}`, title: each.description }, each.name));
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
        sub.blockedBy.length > 0 && h("span", { class: "badge blocked", title: `waits on ${sub.blockedBy.join(", ")}` }, "blocked"),
      ),
    ),
  );
}

function signIn() {
  signout.hidden = true;
  const input = h("input", { type: "password", placeholder: "wp_…", style: "width:100%", autocomplete: "off" });
  const box = errorBox();
  const form = h(
    "form",
    {
      class: "panel",
      onsubmit: async (event) => {
        event.preventDefault();
        localStorage.setItem(TOKEN_KEY, input.value.trim());
        try {
          await api("GET", "/labels?maxResults=1");
          route();
        } catch (err) {
          show(box, err);
        }
      },
    },
    h("h2", {}, "Sign in"),
    h("p", { class: "muted" }, "Paste a token: the admin token waypoint printed when it first started, or one from waypoint token create. It stays in this browser."),
    input,
    box,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Sign in")),
  );
  main.replaceChildren(h("div", { class: "signin" }, landing(false), form));
  input.focus();
}

async function board(params) {
  // Older links carry `closed=1`.
  const cancelled = params.get("cancelled") === "1" || params.get("closed") === "1";
  const only = params.get("label") ?? "";
  const withSubtasks = params.get("subtasks") === "1";
  const [tasks, labelList] = await Promise.all([all(`/tasks${cancelled ? "?includeCancelled=true" : ""}`, "tasks"), all("/labels", "labels")]);
  const labels = new Map(labelList.map((each) => [each.id, each]));
  const shown = tasks.filter((task) => !only || task.labels.includes(only));
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    next.delete("closed");
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/?${next}`;
  };
  const filters = h(
    "div",
    { class: "filters" },
    h("select", { onchange: (e) => set("label", e.target.value) }, h("option", { value: "" }, "Every label"), labelList.map((each) => h("option", { value: each.id, selected: each.id === only }, each.name))),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: cancelled, onchange: (e) => set("cancelled", e.target.checked ? "1" : "") }), "Show cancelled"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: withSubtasks, onchange: (e) => set("subtasks", e.target.checked ? "1" : "") }), "Show subtasks"),
    h("span", { class: "muted" }, `${shown.length} tasks · ${shown.filter((task) => task.ready).length} ready`),
  );
  const columns = (cancelled ? STATUSES : OPEN).map((status) => {
    const here = shown.filter((task) => task.status === status);
    return h(
      "section",
      { class: "column" },
      h("h2", {}, h("span", {}, label(status)), h("span", {}, here.length)),
      here.map((task) =>
        h(
          "a",
          { class: "card", href: `#/task/${task.shortId}` },
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
          withSubtasks && task.subtasks.length > 0 && subtaskList(task),
        ),
      ),
    );
  });
  main.replaceChildren(landing(true), filters, h("div", { class: `board cols-${columns.length}` }, columns));
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

async function taskPage(ref) {
  const { task } = await api("GET", `/tasks/${encodeURIComponent(ref)}`);
  const [tasks, labelList, comments, history] = await Promise.all([
    all("/tasks?includeCancelled=true", "tasks"),
    all("/labels", "labels"),
    all(`/tasks/${task.id}/comments`, "comments"),
    all(`/tasks/${task.id}/history`, "entries"),
  ]);
  const byId = new Map(tasks.map((each) => [each.id, each]));
  const labels = new Map(labelList.map((each) => [each.id, each]));
  const link = (id) => {
    const other = byId.get(id);
    return other ? h("a", { href: `#/task/${other.shortId}` }, `${other.shortId} ${other.title}`, h("span", { class: "muted" }, ` · ${label(other.status)}`)) : h("span", { class: "muted" }, id.slice(0, 8));
  };
  const box = errorBox();
  const update = (changes) => act(box, () => api("PATCH", `/tasks/${task.id}`, changes));

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
      chips(task, labels),
    ),
    box,
    h(
      "div",
      { class: "row" },
      h("select", { onchange: (e) => update({ status: e.target.value }) }, STATUSES.map((status) => h("option", { value: status, selected: status === task.status }, label(status)))),
      CLOSED.includes(task.status)
        ? h("button", { onclick: () => update({ status: "backlog" }) }, "Reopen")
        : [h("button", { onclick: () => update({ status: "done" }) }, "Mark done"), h("button", { onclick: () => update({ status: "cancelled" }) }, "Cancel task")],
      h("button", { onclick: () => editForm(task, tasks, labelList) }, "Edit"),
    ),
    h(
      "div",
      { class: "row" },
      h("span", { class: "muted" }, "Assignee"),
      h("input", { value: task.assignee ?? "", placeholder: "no one", onchange: (e) => update({ assignee: e.target.value.trim() || null }) }),
    ),
  );

  const description = h("div", { class: "panel" }, h("h2", {}, "Description"), task.description ? h("div", { class: "body" }, task.description) : h("div", { class: "muted" }, "Nothing written."));

  const met = task.criteria.filter((criterion) => criterion.met).length;
  const criteria = h(
    "div",
    { class: "panel" },
    h("h2", {}, `Acceptance criteria (${met}/${task.criteria.length})`),
    task.criteria.length === 0
      ? h("div", { class: "muted" }, "None.")
      : h(
          "ul",
          { class: "plain" },
          task.criteria.map((criterion) =>
            h(
              "li",
              {},
              h(
                "label",
                { class: "check" },
                h("input", {
                  type: "checkbox",
                  checked: criterion.met,
                  // Only this entry says `met`, so a tick another caller makes meanwhile stands.
                  onchange: (e) => update({ criteria: task.criteria.map((each) => (each.id === criterion.id ? { id: each.id, met: e.target.checked } : { id: each.id })) }),
                }),
                h("span", {}, criterion.text, criterion.met && h("span", { class: "muted" }, ` · ${who(criterion.metBy)}, ${when(criterion.metAt)}`)),
              ),
            ),
          ),
        ),
  );

  const keep = task.subtasks.map((sub) => ({ id: sub.id }));
  // Every other entry gives only its id, so a change another caller makes to it meanwhile stands.
  const subtasksWith = (sub, entry) => task.subtasks.map((each) => (each.id === sub.id ? { id: each.id, ...entry } : { id: each.id }));
  const subtaskRow = (sub) => {
    const li = h("li", { class: "subtask" });
    const rowBox = errorBox();
    const send = (list) => act(rowBox, () => api("PATCH", `/tasks/${task.id}`, { subtasks: list }));
    const view = () =>
      fill(
        li,
        h(
          "select",
          { onchange: (e) => update({ subtasks: subtasksWith(sub, { status: e.target.value }) }) },
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
              onSave: (value) => act(addBox, () => api("PATCH", `/tasks/${task.id}`, { subtasks: [...keep, value] })),
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

  const text = h("textarea", { placeholder: "Markdown" });
  const talk = h(
    "div",
    { class: "panel" },
    h("h2", {}, "Comments"),
    comments.map((comment) => h("div", { class: "note" }, h("div", { class: "who" }, `${who(comment.author)} · ${when(comment.createdAt)}`), h("div", { class: "body" }, comment.body))),
    h(
      "form",
      { onsubmit: (e) => (e.preventDefault(), act(box, () => api("POST", `/tasks/${task.id}/comments`, { body: text.value }))) },
      text,
      h("div", { class: "row" }, h("button", { type: "submit" }, "Comment")),
    ),
  );

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
        h("li", {}, h("div", { class: "who muted" }, `${entry.action} · ${who(entry.actor)} · ${when(entry.at)}`), h("div", {}, entry.changes.map((change) => change.field).join(", "))),
      ))),
    ),
  );
  main.replaceChildren(h("div", { class: "item" }, h("div", {}, head, description, criteria, subtasks, talk), side));
}

/** A multi-select of `options`, each `[value, text]`, with `chosen` selected. */
const many = (options, chosen) => h("select", { multiple: true, size: Math.min(6, Math.max(2, options.length)) }, options.map(([value, text]) => h("option", { value, selected: chosen.includes(value) }, text)));
const picked = (select) => [...select.selectedOptions].map((option) => option.value);

function fields(task, tasks, labelList) {
  const title = h("input", { value: task?.title ?? "", style: "width:100%", required: true });
  const description = h("textarea", { style: "min-height:160px" });
  description.value = task?.description ?? "";
  const criteria = h("textarea", {});
  criteria.value = (task?.criteria ?? []).map((criterion) => criterion.text).join("\n");
  const dependsOn = many(tasks.filter((other) => other.id !== task?.id).map((other) => [other.id, `${other.shortId} ${other.title}`]), task?.dependsOn ?? []);
  const labels = many(labelList.map((each) => [each.id, each.name]), task?.labels ?? []);
  const lines = (area) => area.value.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    nodes: [
      h("label", {}, "Title"), title,
      h("label", {}, "Description"), description,
      h("label", {}, "Acceptance criteria, one a line"), criteria,
      h("label", {}, "Depends on"), dependsOn,
      h("label", {}, "Labels"), labels,
    ],
    value: () => {
      // A line left as it was keeps its criterion, and whether it is met.
      const current = [...(task?.criteria ?? [])];
      const list = lines(criteria).map((text) => {
        const at = current.findIndex((criterion) => criterion.text === text);
        return at === -1 ? { text } : { id: current.splice(at, 1)[0].id };
      });
      return { title: title.value, description: description.value, criteria: list, dependsOn: picked(dependsOn), labels: picked(labels) };
    },
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
  const subtasks = h("textarea", {});
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
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Create")),
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
    else await board(params);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    main.replaceChildren(h("div", { class: "panel error" }, err.message));
  }
}

signout.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  route();
});
window.addEventListener("hashchange", route);
route();
