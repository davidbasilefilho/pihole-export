import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import { authenticate, fetchQueryPage, fetchSuggestions, logout } from "../src/lib/api";
import { backend, exportNative } from "../src/lib/backend";
import { serializeQuery } from "../src/lib/query";

const session = { valid: true, sid: "synthetic-sid", validity: 1800, totp: false, message: null };
const spec = {
  from: 1788220800.125,
  until: 1788224400.875,
  disk: true,
  domain: " *.example ",
  clientIp: "192.0.2.*",
  clientName: "desk é",
  upstream: "192.0.2.53#53",
  type: "AAAA",
  status: "FORWARDED",
  reply: "IP",
  dnssec: "INSECURE",
};
const page = {
  queries: [],
  cursor: 42,
  recordsTotal: 0,
  recordsFiltered: 0,
  draw: 0,
  earliest_timestamp: 1788220800,
  earliest_timestamp_disk: 1788134400,
};
const run = <T>(effect: Effect.Effect<T, Error>) => Effect.runPromise(effect);

test("Rust API preserves filters, fractional boundaries, auth ownership and TOTP", async () => {
  const requests: { method: string; url: URL; sid: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url,
        sid: request.headers.get("X-FTL-SID"),
        body: request.method === "POST" ? await request.json() : null,
      });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(url.pathname.endsWith("auth") ? { session } : page);
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const form = {
      host: url,
      scheme: "http" as const,
      port: "",
      authMethod: "password" as const,
      secret: "synthetic-password",
      totp: " 123456 ",
    };
    const own = await run(authenticate(url, form));
    expect(requests[0]!.body).toEqual({ password: form.secret, totp: "123456" });
    expect(own.ownedSession).toBeTrue();
    const result = await run(fetchQueryPage(own, spec, 2, 42, 3));
    expect(result.earliest_timestamp_disk).toBe(page.earliest_timestamp_disk);
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual(
      Object.fromEntries(serializeQuery(spec, 2, 42, 3)),
    );
    expect(requests[1]!.sid).toBe("synthetic-sid");
    await run(logout(own));
    const borrowed = await run(
      authenticate(url, { ...form, authMethod: "session", secret: " borrowed " }),
    );
    expect(borrowed.session.sid).toBe("borrowed");
    expect(borrowed.ownedSession).toBeFalse();
    await run(logout(borrowed));
    const none = await run(authenticate(url, { ...form, authMethod: "none" }));
    expect(none.ownedSession).toBeFalse();
    await run(logout(none));
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(requests[3]!.sid).toBe("borrowed");
    expect(requests[4]!.sid).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("Rust reports API/decode errors and never follows credential-bearing redirects", async () => {
  let mode = "error";
  let redirected = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/redirected") {
        redirected++;
        return Response.json({ session });
      }
      if (mode === "error")
        return Response.json(
          { error: { key: "unauthorized", message: "Synthetic failure" } },
          { status: 401 },
        );
      if (mode === "redirect")
        return new Response("{}", { status: 302, headers: { Location: "/redirected" } });
      if (mode === "json") return new Response("not JSON");
      return Response.json({});
    },
  });
  const connection = { baseUrl: `http://127.0.0.1:${server.port}`, session, ownedSession: false };
  try {
    await expect(run(fetchQueryPage(connection, spec, 0))).rejects.toMatchObject({
      _tag: "ApiError",
      status: 401,
      key: "unauthorized",
    });
    for (mode of ["json", "shape"])
      await expect(run(fetchQueryPage(connection, spec, 0))).rejects.toMatchObject({
        _tag: "DecodeError",
      });
    await expect(run(fetchSuggestions(connection))).rejects.toMatchObject({ _tag: "DecodeError" });
    mode = "redirect";
    await expect(run(fetchQueryPage(connection, spec, 0))).rejects.toMatchObject({
      _tag: "ApiError",
      status: 302,
    });
    expect(redirected).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("cancellation interrupts the Rust HTTP export without late writes", async () => {
  let requested!: () => void;
  const started = new Promise<void>((resolve) => (requested = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requested();
      await gate;
      return Response.json(page);
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "pihole-rust-cancel-"));
  const path = join(dir, "out.csv");
  try {
    const fiber = Effect.runFork(
      exportNative(
        { baseUrl: `http://127.0.0.1:${server.port}`, session, ownedSession: false },
        spec,
        path,
        "csv",
      ),
    );
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    const partial = readFileSync(path, "utf8");
    release();
    await Bun.sleep(50);
    expect(readFileSync(path, "utf8")).toBe(partial);
    expect(partial.split("\r\n")).toHaveLength(2);
  } finally {
    release();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backend terminates after a standalone response with stdin still open", async () => {
  expect(
    await run(backend<number>({ op: "time", input: "01/09/2026 00:00:00", timezone: "UTC" })),
  ).toBe(1788220800);
});
