// Tiny ANSI helpers so we don't need a dependency just for colors.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR);

const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function banner() {
  const art = [
    "  ___                    _____     _                   _   ",
    " / _ \\ _ __   ___ _ __ |_   _|__ | |_ ___  __ _  __ _| |_ ___ _ __ ",
    "| | | | '_ \\ / _ \\ '_ \\  | |/ _ \\| __/ _ \\/ _` |/ _` | __/ _ \\ '__|",
    "| |_| | |_) |  __/ | | | | | (_) | ||  __/ (_| | (_| | ||  __/ |   ",
    " \\___/| .__/ \\___|_| |_| |_|\\___/ \\__\\___|\\__, |\\__, |\\__\\___|_|   ",
    "      |_|                                 |___/ |___/            ",
  ];
  console.log(c.cyan(art.join("\n")));
  console.log(c.dim("  let two OpenCode agents debug together over the wire\n"));
}

export const log = (m) => console.log(m);
export const info = (m) => console.log(`${c.cyan("i")} ${m}`);
export const warn = (m) => console.log(`${c.yellow("!")} ${m}`);
export const error = (m) => console.error(`${c.red("✘")} ${m}`);
