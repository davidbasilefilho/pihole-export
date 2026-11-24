import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

import { parquetReadObjects } from "hyparquet";

const rows = [1, 2, 3].map((id) => ({
  id,
  time: 1788220800 + id,
  type: "A",
  domain: `host-${id}.example`,
  cname: null,
  status: "FORWARDED",
  client: { ip: "192.0.2.1", name: 'desk,"á"' },
  dnssec: null,
  reply: { type: "IP", time: 1.5 },
  list_id: null,
  upstream: null,
  ede: { code: 0, text: null },
}));

test("real CLI exports synthetic history to alternate paths and reports write failures", async () => {
  const requests: URL[] = [];
  let allRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      allRequests++;
      const url = new URL(request.url);
      if (url.pathname === "/api/auth")
        return Response.json({
          session: {
            valid: true,
            sid: null,
            csrf: null,
            validity: 1800,
            totp: false,
            message: null,
          },
        });
      if (url.pathname === "/api/queries") {
        requests.push(url);
        return Response.json({
          queries: rows,
          cursor: 3,
          recordsTotal: 3,
          recordsFiltered: 3,
          draw: 0,
          earliest_timestamp: rows[0]!.time,
          earliest_timestamp_disk: rows[0]!.time,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "pihole-cli-"));
  const relativeDir = `cli-output-${process.pid}`;
  mkdirSync(join(dir, relativeDir));
  const entry = resolve("src/index.tsx");
  const invoke = async (output: string, format: string, until = "2026-09-02 00:00:00") => {
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        "--headless",
        "--host",
        `http://127.0.0.1:${server.port}`,
        "--auth",
        "none",
        "--from",
        "2026-09-01 00:00:00",
        "--until",
        until,
        "--timezone",
        "UTC",
        "--disk",
        "--domain",
        "host-*.example",
        "--client-ip",
        "192.0.2.1",
        "--format",
        format,
        "--output",
        output,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const blocked = await invoke(join(dir, "blocked.csv"), "csv", "2026-09-04 00:00:00");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("48 hours are blocked");
    expect(allRequests).toBe(0);
    for (const format of ["csv", "jsonl", "sqlite", "parquet"]) {
      const output =
        format === "jsonl"
          ? relative(process.cwd(), join(dir, relativeDir, "relative file.jsonl"))
          : join(dir, `absolute file.${format}`);
      const result = await invoke(output, format);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ path: output, count: 3, format });
      const path = resolve(output);
      if (format === "jsonl") {
        const records = readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records.map((row) => row.query_id)).toEqual([1, 2, 3]);
        expect(records[0].client_name).toBe(rows[0]!.client.name);
        expect(records[0].time_iso).toBe(new Date(rows[0]!.time * 1000).toISOString());
      } else if (format === "csv") {
        expect(readFileSync(path, "utf8")).toContain('"desk,""á"""');
        expect(readFileSync(path, "utf8").split("\r\n")).toHaveLength(5);
      } else if (format === "sqlite") {
        const db = new Database(path, { readonly: true });
        try {
          expect(db.query("SELECT query_id FROM queries ORDER BY query_id").all()).toEqual([
            { query_id: 1 },
            { query_id: 2 },
            { query_id: 3 },
          ]);
        } finally {
          db.close();
        }
      } else {
        const bytes = readFileSync(path);
        expect(bytes.subarray(0, 4).toString()).toBe("PAR1");
        expect(bytes.subarray(-4).toString()).toBe("PAR1");
        const records = await parquetReadObjects({
          file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        });
        expect(records.map((row) => Number(row.query_id))).toEqual([1, 2, 3]);
        expect(records[0]!.client_name).toBe(rows[0]!.client.name);
        expect(records[0]!.list_id).toBeNull();
      }
    }
    expect(requests).toHaveLength(4);
    for (const url of requests) {
      expect(url.searchParams.get("disk")).toBe("true");
      expect(url.searchParams.get("domain")).toBe("host-*.example");
      expect(url.searchParams.get("client_ip")).toBe("192.0.2.1");
      expect(url.searchParams.get("length")).toBe("10000");
      expect(url.searchParams.get("from")).toBe("1788220800");
    }
    for (const output of [dir, join(dir, "missing", "out.csv")]) {
      const result = await invoke(output, "csv");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("WriteError");
    }
    expect(requests).toHaveLength(4); // destination failures happen before fetching pages
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
