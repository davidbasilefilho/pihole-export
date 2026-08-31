import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

import { Query, WriteError } from "./model";

const quote = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const toCsv = (rows: ReadonlyArray<Query>) => {
  const header = [
    "timestamp",
    "time_iso",
    "domain",
    "client_ip",
    "client_name",
    "type",
    "status",
    "reply",
    "reply_time_ms",
    "upstream",
    "dnssec",
    "cname",
    "list_id",
    "ede_code",
    "ede_text",
    "query_id",
  ];
  const body = rows.map((row) =>
    [
      row.time,
      new Date(row.time * 1000).toISOString(),
      row.domain,
      row.client.ip,
      row.client.name,
      row.type,
      row.status,
      row.reply.type,
      row.reply.time,
      row.upstream,
      row.dnssec,
      row.cname,
      row.list_id,
      row.ede.code,
      row.ede.text,
      row.id,
    ]
      .map(quote)
      .join(","),
  );
  return [header.join(","), ...body].join("\r\n") + "\r\n";
};

export const writeCsv = (path: string, rows: ReadonlyArray<Query>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(path, toCsv(rows))
      .pipe(Effect.mapError((error) => new WriteError({ path, message: String(error) })));
    return { path, count: rows.length };
  });
