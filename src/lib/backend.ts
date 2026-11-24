import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect } from "effect";

import type { AuthenticatedConnection } from "./api";
import { ApiError, DecodeError, NetworkError, ValidationError, WriteError } from "./model";
import type { ExportFormat } from "./model";
import type { QuerySpec } from "./query";

declare const __EMBEDDED_BACKEND__: string;
let extractedBackend: string | undefined;

const offlineTemporaryDirectory = () => {
  if (process.platform !== "linux")
    throw new Error("Offline isolation checks currently support Linux only");
  const mount = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .flatMap((line) => {
      const [left, right] = line.split(" - ");
      const point = left?.split(" ")[4];
      if (!point || !right || !(point === "/" || point === "/tmp")) return [];
      return [{ point, kind: right.split(" ")[0] }];
    })
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (
    !mount ||
    !["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "tmpfs", "overlay"].includes(
      mount.kind ?? "",
    ) ||
    lstatSync("/tmp").isSymbolicLink()
  ) {
    throw new Error("Offline backend extraction requires independent local /tmp storage");
  }
  return "/tmp";
};

export const backendBinary = (offline = false) => {
  if (typeof __EMBEDDED_BACKEND__ !== "undefined") {
    if (extractedBackend !== undefined) return extractedBackend;
    const directory = mkdtempSync(
      join(offline ? offlineTemporaryDirectory() : tmpdir(), "pihole-backend-"),
    );
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
export interface ExportProgress {
  readonly phase: "waiting" | "writing" | "finalizing";
  readonly rows: number;
}
export const backend = <T>(
  request: unknown,
  onProgress?: (progress: ExportProgress) => void,
  offline = false,
) =>
  Effect.tryPromise({
    try: async (signal): Promise<T> => {
      const child = Bun.spawn([backendBinary(offline)], {
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
        const read = async () => {
          let pending = "";
          let final: { ok?: T; error?: Record<string, unknown> } | undefined;
          const decoder = new TextDecoder();
          for await (const bytes of child.stdout) {
            pending += decoder.decode(bytes, { stream: true });
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.progress) {
                if (!signal.aborted) onProgress?.(message.progress);
              } else final = message;
            }
          }
          if (pending.trim()) final = JSON.parse(pending);
          if (!final) throw new Error("Rust backend returned no result");
          return final;
        };
        const [result, code] = await Promise.all([read(), child.exited]);
        if (code !== 0) throw new Error(`Rust backend exited with code ${code}`);
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
  onProgress?: (progress: ExportProgress) => void,
) =>
  backend<{ path: string; count: number; format: ExportFormat }>(
    {
      op: "export",
      connection,
      spec,
      path,
      format,
    },
    onProgress,
  );
