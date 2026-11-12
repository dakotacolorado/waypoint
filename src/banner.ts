/** waypoint's mark: its name in block letters and a pixel map pin, as honed has a sword. */

const LETTERS = [
  "██╗    ██╗ █████╗ ██╗   ██╗██████╗  ██████╗ ██╗███╗   ██╗████████╗",
  "██║    ██║██╔══██╗╚██╗ ██╔╝██╔══██╗██╔═══██╗██║████╗  ██║╚══██╔══╝",
  "██║ █╗ ██║███████║ ╚████╔╝ ██████╔╝██║   ██║██║██╔██╗ ██║   ██║",
  "██║███╗██║██╔══██║  ╚██╔╝  ██╔═══╝ ██║   ██║██║██║╚██╗██║   ██║",
  "╚███╔███╔╝██║  ██║   ██║   ██║     ╚██████╔╝██║██║ ╚████║   ██║",
  " ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝╚═╝  ╚═══╝   ╚═╝",
];

/** A pixel map pin, point down: a ring, its shoulders, and its point, on a 12 by 12 grid, symmetric on both sides. */
export const PIN_PIXELS = [
  "....####....",
  "..########..",
  ".####..####.",
  ".###....###.",
  ".###....###.",
  ".####..####.",
  "..########..",
  "..########..",
  "...######...",
  "....####....",
  ".....##.....",
  ".....##.....",
];

/** The pin as text, two pixels a character, for terminals; the page draws PIN_PIXELS as an image instead. */
const PIN = Array.from({ length: PIN_PIXELS.length / 2 }, (_, row) =>
  [...PIN_PIXELS[row * 2]!]
    .map((top, col) => {
      const t = top === "#", b = PIN_PIXELS[row * 2 + 1]![col] === "#";
      return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    })
    .join("")
    .trimEnd(),
);

export const EMOJI = "📍";

/** The letters alone, for the page, which sets the pin beside them as an image. */
export const LETTERS_ONLY = LETTERS.join("\n");

const WIDTH = Math.max(...LETTERS.map((line) => line.length));
export const WORDMARK = LETTERS.map((line, i) => `${line.padEnd(WIDTH)}  ${PIN[i]}`.trimEnd()).join("\n");

export const TAGLINE = "Know where the work is, and what it waits on.";
/** What waypoint is, in one line. */
export const SUMMARY = "A task tracker with dependency and status management.";

/** The pin as an SVG drawn from its pixel grid, in the page's accent color. */
export const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 ${PIN_PIXELS[0]!.length} ${PIN_PIXELS.length}" shape-rendering="crispEdges" fill="currentColor">${PIN_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => (pixel === "#" ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])),
).join("")}</svg>`;

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
    c.dim(`${EMOJI} v${b.version}`),
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
