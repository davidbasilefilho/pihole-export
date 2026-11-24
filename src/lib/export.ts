import { Effect, Stream } from "effect";

import type { QueryPage } from "./api";
import { backendBinary, backendFailure } from "./backend";
import type { ExportFormat, Query } from "./model";

export interface ExportResult {
  readonly path: string;
  readonly count: number;
  readonly format: ExportFormat;
}

// Acknowledgements bound queued memory to one page. Cancellation closes the worker.
class Writer {
  private child = Bun.spawn([backendBinary()], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  private reader = this.child.stdout.getReader();
  private decoder = new TextDecoder();
  private buffer = "";
  async send<T>(request: unknown): Promise<T> {
    await this.child.stdin.write(JSON.stringify(request) + "\n");
    await this.child.stdin.flush();
    while (!this.buffer.includes("\n")) {
      const part = await this.reader.read();
      if (part.done) throw new Error("Rust writer closed unexpectedly");
      this.buffer += this.decoder.decode(part.value, { stream: true });
    }
    const end = this.buffer.indexOf("\n");
    const result = JSON.parse(this.buffer.slice(0, end));
    this.buffer = this.buffer.slice(end + 1);
    if (result.error) throw backendFailure(result.error);
    return result.ok;
  }
  close() {
    void Promise.resolve(this.child.stdin.end()).catch(() => {});
    if (this.child.exitCode === null) this.child.kill();
  }
}
const attempt = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) });
export const exportQueryPages = <E, R>(
  path: string,
  format: ExportFormat,
  pages: Stream.Stream<QueryPage, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Writer()),
    (writer) =>
      Effect.gen(function* () {
        yield* attempt(() => writer.send({ op: "write", path, format }));
        yield* Stream.runForEach(pages, (page) =>
          attempt(() => writer.send({ rows: page.queries })),
        );
        return yield* attempt(() => writer.send<ExportResult>({ finish: true }));
      }),
    (writer) => Effect.sync(() => writer.close()),
  );
export const writeCsv = (path: string, rows: ReadonlyArray<Query>) =>
  exportQueryPages(
    path,
    "csv",
    Stream.succeed({ queries: rows, cursor: null, recordsFiltered: rows.length }),
  );
