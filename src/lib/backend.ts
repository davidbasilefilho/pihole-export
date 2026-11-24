import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect } from "effect";

import type { AuthenticatedConnection } from "./api";
import { ApiError, DecodeError, NetworkError, ValidationError, WriteError } from "./model";
import type { ExportFormat } from "./model";
import type { QuerySpec } from "./query";

declare const __EMBEDDED_BACKEND__: string;
let extractedBackend: string | undefined;

export const backendBinary = () => {
  if (typeof __EMBEDDED_BACKEND__ !== "undefined") {
    if (extractedBackend !== undefined) return extractedBackend;
    const directory = mkdtempSync(join(tmpdir(), "pihole-backend-"));
    const path = join(
      directory,
      process.platform === "win32" ? "pihole-backend.exe" : "pihole-backend",
    );
    try {
      writeFileSync(path, Buffer.from(__EMBEDDED_BACKEND__, "base64"), { flag: "wx", mode: 0o700 });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    process.once("exit", () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* Windows may still be reaping the child. */
      }
    });
    extractedBackend = path;
    return path;
  }
  const name = process.platform === "win32" ? "pihole-backend.exe" : "pihole-backend";
  const candidates = [
    process.env.PIHOLE_BACKEND_PATH,
    join(dirname(process.execPath), name),
    resolve("bin", name),
    resolve("target/debug", name),
    resolve("target/release", name),
    resolve(import.meta.dir, "../../target/debug", name),
  ];
  const path = candidates.find((path) => path !== undefined && existsSync(path));
  if (path === undefined)
    throw new Error("Rust backend missing; run mise run compile or set PIHOLE_BACKEND_PATH");
  return path;
};
export const backendFailure = (error: Record<string, unknown>) => {
  const message = typeof error.message === "string" ? error.message : "Backend failed";
  switch (error._tag) {
    case "ApiError":
      return new ApiError({ message, status: Number(error.status), key: String(error.key) });
    case "WriteError":
      return new WriteError({ message, path: String(error.path) });
    case "NetworkError":
      return new NetworkError({ message });
    case "DecodeError":
      return new DecodeError({ message });
    default:
      return new ValidationError({ message });
  }
};

// Secrets travel on stdin, never command arguments or diagnostic output.
export const backend = <T>(request: unknown) =>
  Effect.tryPromise({
    try: async (signal): Promise<T> => {
      const child = Bun.spawn([backendBinary()], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        try {
          void Promise.resolve(child.stdin.write('{"cancel":true}\n')).catch(() => {});
          void Promise.resolve(child.stdin.flush()).catch(() => {});
        } catch {
          /* already closed */
        }
        timer = setTimeout(() => child.kill(), 2500);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await child.stdin.write(JSON.stringify(request) + "\n");
        await child.stdin.flush();
        if (signal.aborted) abort();
        const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (code !== 0) throw new Error(`Rust backend exited with code ${code}`);
        const result = JSON.parse(output);
        if (result.error !== undefined) throw backendFailure(result.error);
        return result.ok as T;
      } finally {
        signal.removeEventListener("abort", abort);
        if (timer !== undefined) clearTimeout(timer);
        void Promise.resolve(child.stdin.end()).catch(() => {});
        if (child.exitCode === null) child.kill();
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

export const exportNative = (
  connection: AuthenticatedConnection,
  spec: QuerySpec,
  path: string,
  format: ExportFormat,
) =>
  backend<{ path: string; count: number; format: ExportFormat }>({
    op: "export",
    connection,
    spec,
    path,
    format,
  });
