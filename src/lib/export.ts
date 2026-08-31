import { Database } from "bun:sqlite";

import { FileSystem } from "@effect/platform";
import { Effect, Stream } from "effect";
import { fileWriter, ParquetWriter, type SchemaElement } from "hyparquet-writer";

import type { QueryPage } from "./api";
import { ExportFormat, Query, WriteError } from "./model";

const columns = [
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
] as const;

const values = (row: Query): ReadonlyArray<string | number | null> => [
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
];

const record = (row: Query) =>
  Object.fromEntries(columns.map((name, index) => [name, values(row)[index]]));

const quote = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const csvHeader = columns.join(",") + "\r\n";
export const queryToCsv = (row: Query) => values(row).map(quote).join(",") + "\r\n";
export const toCsv = (rows: ReadonlyArray<Query>) => csvHeader + rows.map(queryToCsv).join("");
export const queryToJsonl = (row: Query) => JSON.stringify(record(row)) + "\n";

const writeFailure = (path: string, error: unknown) =>
  new WriteError({ path, message: String(error) });

const writeTextStream = <E, R>(
  path: string,
  pages: Stream.Stream<QueryPage, E, R>,
  format: "csv" | "jsonl",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(path, format === "csv" ? csvHeader : "")
      .pipe(Effect.mapError((error) => writeFailure(path, error)));
    let count = 0;
    yield* pages.pipe(
      Stream.runForEach((page) => {
        const chunk = page.queries.map(format === "csv" ? queryToCsv : queryToJsonl).join("");
        count += page.queries.length;
        return chunk === ""
          ? Effect.void
          : fs
              .writeFileString(path, chunk, { flag: "a" })
              .pipe(Effect.mapError((error) => writeFailure(path, error)));
      }),
    );
    return { path, count, format } as const;
  });

const sqliteColumns = columns
  .map((name) =>
    ["timestamp", "reply_time_ms"].includes(name)
      ? `${name} REAL`
      : ["list_id", "ede_code", "query_id"].includes(name)
        ? `${name} INTEGER`
        : `${name} TEXT`,
  )
  .join(", ");

const writeSqliteStream = <E, R>(path: string, pages: Stream.Stream<QueryPage, E, R>) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => new Database(path, { create: true }),
      catch: (error) => writeFailure(path, error),
    }),
    (database) =>
      Effect.gen(function* () {
        const insert = yield* Effect.try({
          try: () => {
            database.exec("DROP TABLE IF EXISTS queries");
            database.exec(`CREATE TABLE queries (${sqliteColumns})`);
            const placeholders = columns.map(() => "?").join(",");
            return database.prepare(`INSERT INTO queries VALUES (${placeholders})`);
          },
          catch: (error) => writeFailure(path, error),
        });
        let count = 0;
        yield* pages.pipe(
          Stream.runForEach((page) =>
            Effect.try({
              try: () => {
                const transaction = database.transaction((rows: ReadonlyArray<Query>) => {
                  for (const row of rows) insert.run(...values(row));
                });
                transaction(page.queries);
                count += page.queries.length;
              },
              catch: (error) => writeFailure(path, error),
            }),
          ),
        );
        yield* Effect.try({
          try: () => {
            database.exec("CREATE INDEX queries_time ON queries(timestamp)");
            database.exec("CREATE INDEX queries_domain ON queries(domain)");
          },
          catch: (error) => writeFailure(path, error),
        });
        return { path, count, format: "sqlite" as const };
      }),
    (database) => Effect.sync(() => database.close()),
  );

const parquetSchema: SchemaElement[] = [
  { name: "root", num_children: columns.length },
  ...columns.map((name): SchemaElement => ({
    name,
    type: ["timestamp", "reply_time_ms"].includes(name)
      ? "DOUBLE"
      : ["list_id", "ede_code", "query_id"].includes(name)
        ? "INT64"
        : "BYTE_ARRAY",
    ...(["timestamp", "reply_time_ms", "ede_code", "query_id"].includes(name)
      ? {}
      : { converted_type: "UTF8" as const }),
    repetition_type: [
      "client_name",
      "status",
      "reply",
      "upstream",
      "dnssec",
      "cname",
      "list_id",
      "ede_text",
    ].includes(name)
      ? "OPTIONAL"
      : "REQUIRED",
  })),
];

const parquetData = (rows: ReadonlyArray<Query>) =>
  columns.map((name, index) => ({
    name,
    data: rows.map((row) => {
      const value = values(row)[index];
      return ["list_id", "ede_code", "query_id"].includes(name) &&
        value !== null &&
        value !== undefined
        ? BigInt(value)
        : value;
    }),
  }));

const writeParquetStream = <E, R>(path: string, pages: Stream.Stream<QueryPage, E, R>) =>
  Effect.try({
    try: () => new ParquetWriter({ writer: fileWriter(path), schema: parquetSchema }),
    catch: (error) => writeFailure(path, error),
  }).pipe(
    Effect.flatMap((writer) => {
      let count = 0;
      return pages.pipe(
        Stream.runForEach((page) =>
          Effect.try({
            try: () => {
              if (page.queries.length > 0) writer.write({ columnData: parquetData(page.queries) });
              count += page.queries.length;
            },
            catch: (error) => writeFailure(path, error),
          }),
        ),
        Effect.tap(() =>
          Effect.try({
            try: () => writer.finish(),
            catch: (error) => writeFailure(path, error),
          }),
        ),
        Effect.map(() => ({ path, count, format: "parquet" as const })),
      );
    }),
  );

export interface ExportResult {
  readonly path: string;
  readonly count: number;
  readonly format: ExportFormat;
}

export const exportQueryPages = <E, R>(
  path: string,
  format: ExportFormat,
  pages: Stream.Stream<QueryPage, E, R>,
): Effect.Effect<ExportResult, E | WriteError, R | FileSystem.FileSystem> => {
  switch (format) {
    case "csv":
    case "jsonl":
      return writeTextStream(path, pages, format);
    case "sqlite":
      return writeSqliteStream(path, pages);
    case "parquet":
      return writeParquetStream(path, pages);
  }
};

export const writeCsv = (path: string, rows: ReadonlyArray<Query>) =>
  writeTextStream(
    path,
    Stream.succeed({ queries: rows, cursor: null, recordsFiltered: rows.length }),
    "csv",
  );
