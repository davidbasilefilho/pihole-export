import { Effect } from "effect";

import { ConnectionForm, FilterForm, ValidationError } from "./model";
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

export const defaultFilename = (spec: QuerySpec) => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/[:.]/g, "-");
  const suffix = textFilters.flatMap((key) =>
    spec[key].trim() === "" ? [] : [`${key}-${spec[key].replace(/[^a-z0-9*.-]+/gi, "_")}`],
  );
  return [`pihole`, iso(spec.from), iso(spec.until), ...suffix].join("_") + ".csv";
};
