import { Effect } from "effect";

import { ConnectionForm, FilterForm, Query, ValidationError } from "./model";
import { localToEpochSeconds } from "./time";

export interface QuerySpec {
  readonly from: number;
  readonly until: number;
  readonly disk: boolean;
  readonly domain: string;
  readonly clientIp: string;
  readonly clientName: string;
  readonly upstream: string;
  readonly type: string;
  readonly status: string;
  readonly reply: string;
  readonly dnssec: string;
}

export const baseUrl = (form: ConnectionForm) =>
  Effect.try({
    try: () => {
      const raw = form.host.includes("://") ? form.host : `${form.scheme}://${form.host}`;
      const url = new URL(raw);
      if (form.port.trim() !== "") url.port = form.port.trim();
      url.pathname = url.pathname.replace(/\/(?:api|admin)\/?$/, "").replace(/\/$/, "");
      return url.toString().replace(/\/$/, "");
    },
    catch: () => new ValidationError({ message: "Enter a valid Pi-hole IP, domain, or URL" }),
  });

export const toQuerySpec = (form: FilterForm) =>
  Effect.gen(function* () {
    const from = yield* localToEpochSeconds(form.from, form.timezone);
    const until = yield* localToEpochSeconds(form.until, form.timezone);
    if (until <= from)
      return yield* new ValidationError({ message: "Until must be later than From" });
    return { ...form, from, until } satisfies QuerySpec;
  });

const textFilters = [
  "domain",
  "clientIp",
  "clientName",
  "upstream",
  "type",
  "status",
  "reply",
  "dnssec",
] as const;

export const needsHeavyQueryConfirmation = (spec: QuerySpec) =>
  spec.until - spec.from > 48 * 60 * 60 && textFilters.every((key) => spec[key].trim() === "");

export const serializeQuery = (spec: QuerySpec, start = 0, cursor?: number, length = 10_000) => {
  const params = new URLSearchParams({
    from: String(spec.from),
    until: String(spec.until),
    disk: String(spec.disk),
    length: String(length),
    start: String(start),
  });
  const apiNames = {
    domain: "domain",
    clientIp: "client_ip",
    clientName: "client_name",
    upstream: "upstream",
    type: "type",
    status: "status",
    reply: "reply",
    dnssec: "dnssec",
  } as const;
  for (const key of textFilters)
    if (spec[key].trim() !== "") params.set(apiNames[key], spec[key].trim());
  if (cursor !== undefined) params.set("cursor", String(cursor));
  return params;
};

export const defaultFilename = (spec: QuerySpec, extension = "csv") => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/[:.]/g, "-");
  const suffix = textFilters.flatMap((key) =>
    spec[key].trim() === "" ? [] : [`${key}-${spec[key].replace(/[^a-z0-9*.-]+/gi, "_")}`],
  );
  return [`pihole`, iso(spec.from), iso(spec.until), ...suffix].join("_") + `.${extension}`;
};

export type ResultSort = "time-desc" | "time-asc" | "domain" | "client" | "status";

export const searchAndSortQueries = (
  rows: ReadonlyArray<Query>,
  search: string,
  sort: ResultSort,
) => {
  const needle = search.trim().toLocaleLowerCase();
  const filtered =
    needle === ""
      ? [...rows]
      : rows.filter((row) =>
          [
            row.domain,
            row.client.ip,
            row.client.name,
            row.type,
            row.status,
            row.reply.type,
            row.upstream,
            row.dnssec,
          ].some((value) => value?.toLocaleLowerCase().includes(needle)),
        );
  const text = (value: string | null) => value ?? "";
  filtered.sort((left, right) => {
    switch (sort) {
      case "time-asc":
        return left.time - right.time;
      case "domain":
        return left.domain.localeCompare(right.domain) || right.time - left.time;
      case "client":
        return text(left.client.name ?? left.client.ip).localeCompare(
          text(right.client.name ?? right.client.ip),
        );
      case "status":
        return text(left.status).localeCompare(text(right.status)) || right.time - left.time;
      case "time-desc":
        return right.time - left.time;
    }
  });
  return filtered;
};

export type RefinableField = "domain" | "clientIp" | "clientName" | "upstream" | "type" | "status";

export const refineFiltersFromQuery = (
  filters: FilterForm,
  row: Query,
  field: RefinableField,
): FilterForm => ({
  ...filters,
  [field]:
    field === "domain"
      ? row.domain
      : field === "clientIp"
        ? row.client.ip
        : field === "clientName"
          ? (row.client.name ?? "")
          : field === "upstream"
            ? (row.upstream ?? "")
            : field === "type"
              ? row.type
              : (row.status ?? ""),
});
