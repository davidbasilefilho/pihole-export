import { Effect, Schema } from "effect";

import { authenticate, logout, streamQueryPages } from "./api";
import { exportQueryPages } from "./export";
import {
  AuthMethod,
  CliError,
  ConnectionForm,
  ExportFormat,
  FilterForm,
  ValidationError,
} from "./model";
import { baseUrl, toQuerySpec } from "./query";
import type { AppServices } from "./runtime";
import { defaultRange } from "./time";

export interface HeadlessOptions {
  readonly connection: ConnectionForm;
  readonly filters: FilterForm;
  readonly format: ExportFormat;
  readonly output: string;
}

const valueFlags = new Set([
  "host",
  "scheme",
  "port",
  "auth",
  "from",
  "until",
  "timezone",
  "domain",
  "client-ip",
  "client-name",
  "upstream",
  "type",
  "status",
  "reply",
  "dnssec",
  "format",
  "output",
]);

const parseFlags = (args: ReadonlyArray<string>) => {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--headless") continue;
    if (token === "--disk") {
      flags.set("disk", "true");
      continue;
    }
    if (!token?.startsWith("--"))
      return Effect.fail(new CliError({ message: `Unexpected argument: ${token ?? ""}` }));
    const name = token.slice(2);
    if (!valueFlags.has(name))
      return Effect.fail(new CliError({ message: `Unknown option: --${name}` }));
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      return Effect.fail(new CliError({ message: `Missing value for --${name}` }));
    flags.set(name, value);
    index += 1;
  }
  return Effect.succeed(flags);
};

export const parseHeadlessOptions = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env,
) =>
  Effect.gen(function* () {
    const flags = yield* parseFlags(args);
    const range = yield* Effect.try({
      try: () => defaultRange(flags.get("timezone")),
      catch: (error) => new CliError({ message: `Invalid timezone: ${String(error)}` }),
    });
    const auth = yield* Schema.decodeUnknown(AuthMethod)(flags.get("auth") ?? "password").pipe(
      Effect.mapError(() => new CliError({ message: "--auth must be password, session, or none" })),
    );
    const format = yield* Schema.decodeUnknown(ExportFormat)(flags.get("format") ?? "csv").pipe(
      Effect.mapError(
        () => new CliError({ message: "--format must be csv, jsonl, sqlite, or parquet" }),
      ),
    );
    const secret =
      auth === "password"
        ? (env.PIHOLE_PASSWORD ?? "")
        : auth === "session"
          ? (env.PIHOLE_SESSION_ID ?? "")
          : "";
    const raw = {
      connection: {
        host: flags.get("host") ?? "",
        scheme: flags.get("scheme") ?? "http",
        port: flags.get("port") ?? "",
        authMethod: auth,
        secret,
        totp: auth === "password" ? (env.PIHOLE_TOTP ?? "") : "",
      },
      filters: {
        from: flags.get("from") ?? range.from,
        until: flags.get("until") ?? range.until,
        timezone: flags.get("timezone") ?? range.timezone,
        disk: flags.get("disk") === "true",
        domain: flags.get("domain") ?? "",
        clientIp: flags.get("client-ip") ?? "",
        clientName: flags.get("client-name") ?? "",
        upstream: flags.get("upstream") ?? "",
        type: flags.get("type") ?? "",
        status: flags.get("status") ?? "",
        reply: flags.get("reply") ?? "",
        dnssec: flags.get("dnssec") ?? "",
      },
      format,
      output: flags.get("output") ?? "",
    };
    if (raw.output.trim() === "")
      return yield* new CliError({ message: "Headless mode requires --output" });
    const connection = yield* Schema.decodeUnknown(ConnectionForm)(raw.connection).pipe(
      Effect.mapError((error) => new ValidationError({ message: String(error) })),
    );
    const filters = yield* Schema.decodeUnknown(FilterForm)(raw.filters).pipe(
      Effect.mapError((error) => new ValidationError({ message: String(error) })),
    );
    return { connection, filters, format, output: raw.output } satisfies HeadlessOptions;
  });

export const runHeadless = (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<
  { readonly path: string; readonly count: number; readonly format: ExportFormat },
  unknown,
  AppServices
> =>
  Effect.gen(function* () {
    const options = yield* parseHeadlessOptions(args, env);
    const url = yield* baseUrl(options.connection);
    const spec = yield* toQuerySpec(options.filters);
    return yield* Effect.acquireUseRelease(
      authenticate(url, options.connection),
      (connection) =>
        exportQueryPages(options.output, options.format, streamQueryPages(connection, spec)),
      (connection) =>
        Effect.suspend(() => logout(connection)).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.asVoid,
        ),
    );
  });

export const isHeadlessInvocation = (args: ReadonlyArray<string>) => args.includes("--headless");

export const headlessUsage = `pihole-export --headless --host HOST --output PATH [options]

Credentials are accepted only through PIHOLE_PASSWORD, PIHOLE_TOTP, or PIHOLE_SESSION_ID.
Options: --auth password|session|none, --scheme http|https, --port PORT,
--from DATE, --until DATE, --timezone IANA, --disk, query filter flags,
and --format csv|jsonl|sqlite|parquet.`;
