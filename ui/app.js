// waypoint's page: the board, an item, and a form for a new one, over the same API agents use.
// Every element is made with `h`, which sets text, never HTML, so nothing an item says is run.

import { EMOJI, LETTERS, PIN_SVG, SUMMARY, TAGLINE } from "./banner.js";

const STATUSES = ["backlog", "ready", "in_progress", "review", "done"];
const TYPES = ["epic", "story", "task"];
const PARENT = { epic: null, story: "epic", task: "story" };
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

/** Where this page is served, as `https://host/waypoint/`: the base of the API and the MCP server too. */
const base = () => `${location.origin}${location.pathname}`;

/** The block-letter name with the pin beside it; `small` above the board. The SVG is the server's own constant, not anything an item says. */
function wordmark(small = false) {
  const pin = new DOMParser().parseFromString(PIN_SVG, "image/svg+xml").documentElement;
  return h("a", { class: `wordmark${small ? " small" : ""}`, href: "#/", "aria-label": "waypoint" }, h("pre", { "aria-hidden": "true" }, LETTERS), document.importNode(pin, true));
}

/** The page's own landing: the mark, what waypoint is, and where its API and MCP server answer. */
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
      h("code", {}, `${base()}items`),
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
    super(body?.error ?? `HTTP ${status}`);
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
    throw new ApiError(401, { error: "That token is not one this server knows." });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const when = (iso) => new Date(iso).toLocaleString();
const label = (status) => status.replace("_", " ");
const errorBox = () => h("div", { class: "error", hidden: true });
const show = (box, err) => {
  box.hidden = false;
  box.textContent = err.message;
};

/** Runs `fn`, showing what refused it in `box`, then rerenders the page. */
async function act(box, fn) {
  try {
    await fn();
    route();
  } catch (err) {
    show(box, err);
  }
}

function badge(type) {
  return h("span", { class: `badge ${type}` }, type);
}

function tagChips(item, tags) {
  return item.tags.map((id) => tags.get(id)).filter(Boolean).map((tag) => h("span", { class: "tag", style: `background:${tag.color}`, title: tag.description }, tag.value));
}

function signIn() {
  signout.hidden = true;
  const input = h("input", { type: "password", placeholder: "wp_…", style: "width:100%", autocomplete: "off" });
  const box = errorBox();
  const form = h(
    "form",
    {
      class: "panel signin",
      onsubmit: async (event) => {
        event.preventDefault();
        localStorage.setItem(TOKEN_KEY, input.value.trim());
        try {
          await api("GET", "/tags");
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
  const type = params.get("type") ?? "";
  const under = params.get("under") ?? "";
  const closed = params.get("closed") === "1";
  const [{ items }, { tags }] = await Promise.all([api("GET", "/items"), api("GET", "/tags")]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  const beneath = (item, top) => {
    for (let at = item.parent; at; at = byId.get(at)?.parent) if (at === top) return true;
    return false;
  };
  const shown = items
    .filter((item) => closed || item.state === "open")
    .filter((item) => !type || item.type === type)
    .filter((item) => !under || beneath(item, under));
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/?${next}`;
  };
  const epics = items.filter((item) => item.type === "epic" && item.state === "open");
  const filters = h(
    "div",
    { class: "filters" },
    h("select", { onchange: (e) => set("type", e.target.value) }, h("option", { value: "" }, "Every type"), TYPES.map((t) => h("option", { value: t, selected: t === type }, `${t}s`))),
    h(
      "select",
      { onchange: (e) => set("under", e.target.value) },
      h("option", { value: "" }, "Under any epic"),
      epics.map((epic) => h("option", { value: epic.id, selected: epic.id === under }, `${epic.shortId} ${epic.title}`)),
    ),
    h("label", { style: "margin:0;text-transform:none;letter-spacing:0;display:flex;gap:6px;align-items:center" }, h("input", { type: "checkbox", checked: closed, onchange: (e) => set("closed", e.target.checked ? "1" : "") }), "Show closed"),
    h("span", { class: "muted" }, `${shown.length} of ${items.length} items`),
  );
  const columns = STATUSES.map((status) => {
    const here = shown.filter((item) => item.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return h(
      "section",
      { class: "column" },
      h("h2", {}, h("span", {}, label(status)), h("span", {}, here.length)),
      here.map((item) =>
        h(
          "a",
          { class: "card", href: `#/item/${item.shortId}` },
          h("div", { class: "title" }, item.title),
          h(
            "div",
            { class: "meta" },
            badge(item.type),
            h("span", {}, item.shortId),
            item.state === "closed" && h("span", { class: "badge closed" }, item.closedReason.replace("_", " ")),
            item.blockedBy.length > 0 && h("span", { class: "badge blocked" }, `blocked by ${item.blockedBy.length}`),
            item.heldBy && h("span", {}, `· ${item.heldBy}`),
            item.parent && byId.get(item.parent) && h("span", {}, `· ${byId.get(item.parent).title}`),
            tagChips(item, tagMap),
          ),
        ),
      ),
    );
  });
  main.replaceChildren(landing(true), filters, h("div", { class: "board" }, columns));
}

async function itemPage(ref) {
  const item = await api("GET", `/items/${encodeURIComponent(ref)}`);
  const [{ items }, { tags }, { comments }, { entries: log }, { entries: history }] = await Promise.all([
    api("GET", "/items"),
    api("GET", "/tags"),
    api("GET", `/items/${item.id}/comments`),
    api("GET", `/items/${item.id}/work-log`),
    api("GET", `/items/${item.id}/history`),
  ]);
  const byId = new Map(items.map((each) => [each.id, each]));
  const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
  const link = (id) => {
    const other = byId.get(id);
    return other ? h("a", { href: `#/item/${other.shortId}` }, `${other.shortId} ${other.title}`) : h("span", { class: "muted" }, id.slice(0, 8));
  };
  const crumbs = [];
  for (let at = item.parent; at; at = byId.get(at)?.parent) crumbs.unshift(link(at), " / ");
  const box = errorBox();
  const patch = (changes) => act(box, () => api("PATCH", `/items/${item.id}`, changes));
  const parentOf = item.children.length > 0;

  const head = h(
    "div",
    { class: "panel" },
    h("div", { class: "crumbs" }, crumbs),
    h("h1", {}, item.title),
    h(
      "div",
      { class: "meta" },
      badge(item.type),
      h("span", {}, item.shortId),
      h("span", {}, `· ${label(item.status)}${parentOf ? " (from its children)" : ""}`),
      item.state === "closed" && h("span", { class: "badge closed" }, `closed: ${item.closedReason.replace("_", " ")}`),
      item.heldBy && h("span", {}, `· held by ${item.heldBy}`),
      tagChips(item, tagMap),
    ),
    box,
    h(
      "div",
      { class: "row" },
      h(
        "select",
        { disabled: parentOf, title: parentOf ? "A parent's status follows its children: move them." : "", onchange: (e) => patch({ status: e.target.value }) },
        STATUSES.map((status) => h("option", { value: status, selected: status === item.status }, label(status))),
      ),
      item.state === "open"
        ? [
            h("button", { onclick: () => patch({ state: "closed", closedReason: "completed" }) }, "Close as completed"),
            h("button", { onclick: () => patch({ state: "closed", closedReason: "not_planned" }) }, "Close as not planned"),
          ]
        : h("button", { onclick: () => patch({ state: "open" }) }, "Reopen"),
      item.type !== "task" && h("a", { href: `#/new?parent=${item.shortId}` }, `+ New ${item.type === "epic" ? "story" : "task"}`),
      h("button", { onclick: () => editForm(item) }, "Edit"),
    ),
  );

  const body = h("div", { class: "panel" }, h("h2", {}, "Body"), item.body ? h("div", { class: "body" }, item.body) : h("div", { class: "muted" }, "Nothing written."));

  const met = new Map(item.met.map((tick) => [tick.criterion, tick]));
  const criteria = h(
    "div",
    { class: "panel" },
    h("h2", {}, `Acceptance criteria (${met.size}/${item.acceptanceCriteria.length})`),
    item.acceptanceCriteria.length === 0
      ? h("div", { class: "muted" }, "None.")
      : h(
          "ul",
          { class: "plain" },
          item.acceptanceCriteria.map((criterion) => {
            const tick = met.get(criterion.id);
            return h(
              "li",
              {},
              h(
                "label",
                { style: "display:flex;gap:8px;margin:0;text-transform:none;letter-spacing:0;font-size:14px;color:inherit" },
                h("input", {
                  type: "checkbox",
                  checked: Boolean(tick),
                  onchange: (e) => act(box, () => api(e.target.checked ? "POST" : "DELETE", `/items/${item.id}/met`, { criterion: criterion.id })),
                }),
                h("span", {}, criterion.text, tick && h("span", { class: "muted" }, ` · ${tick.by ?? "the person"}, ${when(tick.at)}`)),
              ),
            );
          }),
        ),
  );

  const children = h(
    "div",
    { class: "panel" },
    h("h2", {}, item.type === "epic" ? "Stories" : item.type === "story" ? "Tasks" : "Children"),
    item.children.length === 0
      ? h("div", { class: "muted" }, "None.")
      : h(
          "ul",
          { class: "plain" },
          item.children.map((id) => byId.get(id)).filter(Boolean).map((child) =>
            h("li", {}, link(child.id), h("span", { class: "muted" }, ` · ${label(child.status)}${child.state === "closed" ? `, closed ${child.closedReason.replace("_", " ")}` : ""}`)),
          ),
        ),
  );

  const note = (entry) =>
    h(
      "div",
      { class: "note" },
      h("div", { class: "who" }, `${entry.author ?? "the person"} · ${when(entry.at)}`),
      h("div", { class: "body" }, entry.body),
      (entry.links ?? []).map((url) => h("div", {}, h("a", { href: url, target: "_blank", rel: "noreferrer" }, url))),
    );
  const noteForm = (path, extra) => {
    const text = h("textarea", { placeholder: "Markdown" });
    const links = extra ? h("input", { placeholder: "Links, space-separated", style: "width:100%;margin-top:6px" }) : null;
    return h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          act(box, () => api("POST", path, { body: text.value, ...(links && { links: links.value.split(/\s+/).filter(Boolean) }) }));
        },
      },
      text,
      links,
      h("div", { class: "row" }, h("button", { type: "submit" }, "Add")),
    );
  };

  const talk = h("div", { class: "panel" }, h("h2", {}, "Comments"), comments.map(note), noteForm(`/items/${item.id}/comments`, false));
  const work = h("div", { class: "panel" }, h("h2", {}, "Work log"), log.map(note), noteForm(`/items/${item.id}/work-log`, true));

  const tagSelect = h("select", {}, h("option", { value: "" }, "Add a tag…"), tags.filter((tag) => !item.tags.includes(tag.id)).map((tag) => h("option", { value: tag.id }, tag.value)));
  const side = h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Depends on"),
      item.dependsOn.length === 0 ? h("div", { class: "muted" }, "Nothing.") : h("ul", { class: "plain" }, item.dependsOn.map((id) => h("li", {}, link(id)))),
      item.blockedBy.length > 0 && [h("h2", { style: "margin-top:12px" }, "Blocked by"), h("ul", { class: "plain" }, item.blockedBy.map((id) => h("li", {}, link(id))))],
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Tags"),
      h("div", { class: "row", style: "margin-top:0" }, item.tags.map((id) => tagMap.get(id)).filter(Boolean).map((tag) =>
        h("span", { class: "tag", style: `background:${tag.color}` }, tag.value, " ", h("a", { href: "#", style: "color:#fff", title: "Take it off", onclick: (e) => { e.preventDefault(); act(box, () => api("DELETE", `/items/${item.id}/tags/${tag.id}`)); } }, "×")),
      )),
      h("div", { class: "row" }, tagSelect, h("button", { onclick: () => tagSelect.value && act(box, () => api("POST", `/items/${item.id}/tags`, { tag: tagSelect.value })) }, "Add")),
    ),
    h(
      "div",
      { class: "panel" },
      h("details", {}, h("summary", {}, `History (${history.length})`), h("ul", { class: "plain" }, history.slice().reverse().map((entry) =>
        h("li", {}, h("div", { class: "who muted" }, `${entry.action}${entry.item !== item.id ? ` ${byId.get(entry.item)?.shortId ?? entry.item.slice(0, 8)}` : ""} · ${entry.claimedBy ?? "the person"} · ${when(entry.at)}`), h("div", {}, entry.changes.map((change) => change.field).join(", "))),
      ))),
    ),
  );
  main.replaceChildren(h("div", { class: "item" }, h("div", {}, head, body, criteria, children, talk, work), side));
}

function editForm(item) {
  const title = h("input", { value: item.title, style: "width:100%" });
  const body = h("textarea", { style: "min-height:200px" });
  body.value = item.body;
  const criteria = h("textarea", {});
  // A line left as it was keeps its criterion's id and tick: the API matches it by its text.
  criteria.value = item.acceptanceCriteria.map((criterion) => criterion.text).join("\n");
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("PATCH", `/items/${item.id}`, { title: title.value, body: body.value, acceptanceCriteria: criteria.value.split("\n").map((line) => line.trim()).filter(Boolean) });
            location.hash = `#/item/${item.shortId}`;
            route();
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, `Edit ${item.shortId}`),
      h("label", {}, "Title"),
      title,
      h("label", {}, "Body"),
      body,
      h("label", {}, "Acceptance criteria, one a line"),
      criteria,
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Save"), h("a", { href: `#/item/${item.shortId}` }, "Cancel")),
    ),
  );
}

async function newItem(params) {
  const { items } = await api("GET", "/items?state=open");
  const parentRef = params.get("parent");
  const given = parentRef ? items.find((item) => item.shortId === parentRef || item.id === parentRef) : undefined;
  const type = h("select", {}, TYPES.map((t) => h("option", { value: t, selected: given ? PARENT[t] === given.type : t === "epic" }, t)));
  const parent = h("select", {});
  const fillParents = () => {
    const needs = PARENT[type.value];
    parent.replaceChildren(
      ...(needs === null
        ? [h("option", { value: "" }, "None: an epic has no parent")]
        : items.filter((item) => item.type === needs).map((item) => h("option", { value: item.id, selected: item.id === given?.id }, `${item.shortId} ${item.title}`))),
    );
    parent.disabled = needs === null;
  };
  type.addEventListener("change", fillParents);
  fillParents();
  const title = h("input", { style: "width:100%", required: true });
  const body = h("textarea", { style: "min-height:160px" });
  const criteria = h("textarea", {});
  const status = h("select", {}, STATUSES.slice(0, 2).map((s) => h("option", { value: s }, label(s))));
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const made = await api("POST", "/items", {
              type: type.value,
              title: title.value,
              body: body.value,
              status: status.value,
              parent: parent.disabled ? null : parent.value || null,
              acceptanceCriteria: criteria.value.split("\n").map((line) => line.trim()).filter(Boolean),
            });
            location.hash = `#/item/${made.shortId}`;
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, "New item"),
      h("label", {}, "Type"),
      type,
      h("label", {}, "Parent"),
      parent,
      h("label", {}, "Title"),
      title,
      h("label", {}, "Body"),
      body,
      h("label", {}, "Acceptance criteria, one a line"),
      criteria,
      h("label", {}, "Status"),
      status,
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Create")),
    ),
  );
  title.focus();
}

async function route() {
  if (!token()) return signIn();
  signout.hidden = false;
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(search);
  try {
    const item = /^\/item\/(.+)$/.exec(path ?? "");
    if (item) await itemPage(decodeURIComponent(item[1]));
    else if (path === "/new") await newItem(params);
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
