/** waypoint's mark: its name in block letters beside the mark, two open steps converging on a milestone. */

const LETTERS = [
  "██╗    ██╗ █████╗ ██╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗",
  "██║    ██║██╔══██╗╚██╗ ██╔╝██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝",
  "██║ █╗ ██║███████║ ╚████╔╝ ██████╔╝██║   ██║██║██╔██╗ ██║   ██║",
  "██║███╗██║██╔══██║  ╚██╔╝  ██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║",
  "╚███╔███╔╝██║  ██║   ██║   ██║     ╚██████╔╝██║██║ ╚████║   ██║",
  " ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝",
];

/**
 * The mark on an 18 by 12 grid: two open steps feed a third, which leads to a
 * filled diamond, the goal. The last row is blank so a terminal, drawing two
 * rows a character, gives it as many rows as the letters.
 */
export const MARK_PIXELS = [
  "###...............",
  "#.#...............",
  "####..........#...",
  "....##.......###..",
  "......####..#####.",
  ".......#.#########",
  "......####..#####.",
  "....##.......###..",
  "####..........#...",
  "#.#...............",
  "###...............",
  "..................",
];

/** The mark as text, two pixels a character, for terminals; the page draws MARK_PIXELS as an image instead. */
const MARK = Array.from({ length: MARK_PIXELS.length / 2 }, (_, row) =>
  [...MARK_PIXELS[row * 2]!]
    .map((top, col) => {
      const t = top === "#", b = MARK_PIXELS[row * 2 + 1]![col] === "#";
      return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    })
    .join("")
    .trimEnd(),
);

/** The letters alone, for the page, which sets the mark beside them as an image. */
export const LETTERS_ONLY = LETTERS.join("\n");

const WIDTH = Math.max(...LETTERS.map((line) => line.length));
export const WORDMARK = LETTERS.map((line, i) => `${line.padEnd(WIDTH)}  ${MARK[i]}`.trimEnd()).join("\n");

export const TAGLINE = "Know where you're going, and each step that gets you there.";
/** What waypoint is, in one line. Every place that describes waypoint in a line uses this or TAGLINE, verbatim. */
export const SUMMARY = "A task tracker with dependency and status management.";

/** The pixel mark as an SVG drawn from its grid, in the current color: beside the block letters. */
export const MARK_PIXEL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 ${MARK_PIXELS[0]!.length} ${MARK_PIXELS.length}" shape-rendering="crispEdges" fill="currentColor">${MARK_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => (pixel === "#" ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])),
).join("")}</svg>`;

/** The mark drawn smooth, for small sizes: `ink` strokes it and fills the goal, `ground` fills the open steps. */
const smoothMark = (ink: string, ground: string, style = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="-1 -1 42 18">${style}<g fill="none" stroke="${ink}" stroke-width="2"><path d="M5 3L22 8M5 13L22 8H29"/>${[
    [5, 3],
    [5, 13],
    [22, 8],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${ground}"/>`)
    .join("")}<path d="M34 3L39 8L34 13L29 8Z" fill="${ink}"/></g></svg>`;

/** The smooth mark in the page's colors, for its header. */
export const MARK_SVG = smoothMark("currentColor", "var(--panel)");

/** The smooth mark on its own, as the page's favicon: terracotta, its open steps the tab's light or dark. */
export const MARK_ICON = smoothMark(
  "var(--ink)",
  "var(--ground)",
  "<style>svg{--ink:#c4553d;--ground:#fff}@media (prefers-color-scheme:dark){svg{--ink:#e8846b;--ground:#161615}}</style>",
);

/** Colors only for a terminal that wants them (https://no-color.org). */
export function palette(enabled: boolean) {
  const paint = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { mark: paint("38;5;167"), bold: paint("1"), dim: paint("2") };
}

export interface BannerInfo {
  version: string;
  /** Where it listens. */
  url: string;
  /** Where people and agents reach it: its public HTTPS address behind a proxy, else `url`. */
  publicUrl: string;
  db: string;
  /** The admin token made at this start, shown once; null when one already existed. */
  token: string | null;
  color: boolean;
}

/** What waypoint says when it starts: what it is, where each part is, and the token to sign in with. */
export function banner(b: BannerInfo): string {
  const c = palette(b.color);
  return [
    "",
    c.mark(WORDMARK),
    c.dim(`v${b.version}`),
    "",
    c.bold(TAGLINE),
    SUMMARY,
    "",
    `  ${c.mark("▸")} Page      ${b.publicUrl}/`,
    `  ${c.mark("▸")} API       ${b.publicUrl}/tasks   docs ${b.publicUrl}/docs/api`,
    `  ${c.mark("▸")} MCP       ${b.publicUrl}/mcp     docs ${b.publicUrl}/docs/mcp`,
    "",
    ...(b.token ? [c.bold(`admin token (shown once, kept only as a hash): ${b.token}`), ""] : []),
    `  ${c.dim(`listening on ${b.url}, data in ${b.db}`)}`,
    `  ${c.dim("Ctrl+C to stop.")}`,
    "",
  ].join("\n");
}
