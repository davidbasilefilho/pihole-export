import type { Query } from "./model";

export interface AggregateEntry {
  readonly value: string;
  readonly count: number;
  readonly percentage: number;
}

export interface QueryAnalytics {
  readonly total: number;
  readonly blocked: number;
  readonly allowed: number;
  readonly blockedPercentage: number;
  readonly domains: ReadonlyArray<AggregateEntry>;
  readonly clients: ReadonlyArray<AggregateEntry>;
  readonly upstreams: ReadonlyArray<AggregateEntry>;
  readonly queryTypes: ReadonlyArray<AggregateEntry>;
}

const blockedStatuses = [
  "BLOCKED",
  "GRAVITY",
  "DENYLIST",
  "REGEX",
  "EXTERNAL_BLOCKED",
  "CNAME",
  "DBBUSY",
  "SPECIAL_DOMAIN",
];

export const isBlockedQuery = (row: Query) => {
  const status = row.status?.toUpperCase() ?? "";
  return blockedStatuses.some((blocked) => status.includes(blocked));
};

const ranked = (counts: Map<string, number>, total: number, limit: number) =>
  [...counts]
    .map(([value, count]) => ({
      value,
      count,
      percentage: total === 0 ? 0 : (count / total) * 100,
    }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);

export const analyzeQueries = (rows: ReadonlyArray<Query>, limit = 10): QueryAnalytics => {
  const domains = new Map<string, number>();
  const clients = new Map<string, number>();
  const upstreams = new Map<string, number>();
  const queryTypes = new Map<string, number>();
  let blocked = 0;
  const add = (target: Map<string, number>, value: string) =>
    target.set(value, (target.get(value) ?? 0) + 1);
  for (const row of rows) {
    add(domains, row.domain);
    add(clients, row.client.name ?? row.client.ip);
    add(upstreams, row.upstream ?? "—");
    add(queryTypes, row.type);
    if (isBlockedQuery(row)) blocked += 1;
  }
  const total = rows.length;
  return {
    total,
    blocked,
    allowed: total - blocked,
    blockedPercentage: total === 0 ? 0 : (blocked / total) * 100,
    domains: ranked(domains, total, limit),
    clients: ranked(clients, total, limit),
    upstreams: ranked(upstreams, total, limit),
    queryTypes: ranked(queryTypes, total, limit),
  };
};
