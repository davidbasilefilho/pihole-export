import type { AuthMethod } from "../lib/model";

export type Screen =
  | "connect"
  | "filters"
  | "results"
  | "inspect"
  | "help"
  | "confirm"
  | "export"
  | "suggestions"
  | "search"
  | "presets";

export type ConnectFocus = "host" | "scheme" | "port" | "auth" | "secret" | "totp" | "connect";

export const connectControls = (method: AuthMethod): ReadonlyArray<ConnectFocus> =>
  method === "password"
    ? ["host", "scheme", "port", "auth", "secret", "totp", "connect"]
    : method === "session"
      ? ["host", "scheme", "port", "auth", "secret", "connect"]
      : ["host", "scheme", "port", "auth", "connect"];

export const moveCyclic = <T>(items: ReadonlyArray<T>, current: T, delta: number): T => {
  if (items.length === 0) return current;
  const index = Math.max(0, items.indexOf(current));
  return items[(index + delta + items.length) % items.length] ?? current;
};

export const moveIndex = (current: number, delta: number, count: number, wrap = true) =>
  count <= 0
    ? 0
    : wrap
      ? (current + delta + count) % count
      : Math.max(0, Math.min(count - 1, current + delta));

export const filterControlCount = 14;
export const resultActions = [
  "SEARCH",
  "SORT",
  "AGGREGATE",
  "REFINE",
  "EXPORT",
  "PRESETS",
  "FILTERS",
  "HELP",
] as const;
export type ResultAction = (typeof resultActions)[number];
