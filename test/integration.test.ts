import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { HttpClient } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { Database } from "bun:sqlite"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authenticate, fetchAllQueries, fetchSuggestions, HttpLive, mutateDomain, streamQueryPages } from "../src/lib/api"
import { exportQueryPages, writeCsv } from "../src/lib/export"
import { runHeadless } from "../src/lib/headless"
import { NetworkError, type ConnectionForm } from "../src/lib/model"
import type { QuerySpec } from "../src/lib/query"

const total = 10_005
const pageStarts: Array<{ start: number; cursor: string | null }> = []
const domainMutations: Array<{ path: string; sid: string | null; body: unknown }> = []
const makeQuery = (id: number) => ({
  id,
  time: 1_700_000_000 + id,
  type: "A",
  domain: `host-${id}.example`,
  cname: null,
  status: "FORWARDED",
  client: { ip: "10.0.0.2", name: "desktop" },
  dnssec: "INSECURE",
  reply: { type: "IP", time: 2 },
  list_id: null,
  upstream: "1.1.1.1#53",
  ede: { code: 0, text: null },
})

let server: ReturnType<typeof Bun.serve>
let baseUrl = ""
const temp = mkdtempSync(join(tmpdir(), "pihole-export-test-"))

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    routes: {
      "/api/auth": {
        POST: async (request) => {
          const body = await request.json()
          if (typeof body === "object" && body !== null && "password" in body && body.password === "correct") {
            return Response.json({ session: { valid: true, totp: false, sid: "test-sid", csrf: null, validity: 1800, message: null }, took: 0.001 })
          }
          return Response.json({ error: { key: "unauthorized", message: "Invalid password", hint: null }, took: 0.001 }, { status: 401 })
        },
        GET: () => Response.json({ session: { valid: false, totp: false, sid: null, csrf: null, validity: -1, message: "password required" }, took: 0.001 }, { status: 401 }),
      },
      "/api/queries/suggestions": () => Response.json({ suggestions: {
        domain: ["example.com"], client_ip: ["10.0.0.2"], client_name: ["desktop"], upstream: ["1.1.1.1#53"],
        type: ["A"], status: ["FORWARDED"], reply: ["IP"], dnssec: ["INSECURE"],
      }, took: 0.001 }),
      "/api/queries": (request) => {
        const url = new URL(request.url)
        const start = Number(url.searchParams.get("start") ?? 0)
        pageStarts.push({ start, cursor: url.searchParams.get("cursor") })
        const count = Math.min(10_000, total - start)
        const queries = Array.from({ length: Math.max(0, count) }, (_, index) => makeQuery(start + index + 1))
        return Response.json({ queries, cursor: 50_000, recordsTotal: total, recordsFiltered: total, draw: 0, earliest_timestamp: 1, earliest_timestamp_disk: 1, took: 0.01 })
      },
      "/api/domains/deny/exact": {
        POST: async (request) => {
          const body = await request.json()
          domainMutations.push({ path: new URL(request.url).pathname, sid: request.headers.get("X-FTL-SID"), body })
          if (typeof body === "object" && body !== null && "domain" in body && body.domain === "failure.example")
            return Response.json({ error: { key: "database_error", message: "Domain mutation failed", hint: null } }, { status: 500 })
          return Response.json({ domains: [], processed: { success: [body] }, took: 0.001 }, { status: 201 })
        },
      },
      "/api/domains/allow/exact": {
        POST: async (request) => {
          const body = await request.json()
          domainMutations.push({ path: new URL(request.url).pathname, sid: request.headers.get("X-FTL-SID"), body })
          return Response.json({ domains: [], processed: { success: [body] }, took: 0.001 }, { status: 201 })
        },
      },
      "/slow": async () => {
        await Bun.sleep(5_000)
        return Response.json({})
      },
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
  rmSync(temp, { recursive: true, force: true })
})

const passwordForm = (password: string): ConnectionForm => ({
  host: baseUrl, scheme: "http", port: "", authMethod: "password", secret: password, totp: "",
})
const spec: QuerySpec = {
  from: 1, until: 2_000_000_000, disk: true, domain: "", clientIp: "", clientName: "",
  upstream: "", type: "", status: "", reply: "", dnssec: "",
}
const Live = Layer.merge(HttpLive, BunFileSystem.layer)

describe("Pi-hole HTTP lifecycle", () => {
  test("authenticates successfully and decodes failures", async () => {
    const ok = await Effect.runPromise(authenticate(baseUrl, passwordForm("correct")).pipe(Effect.provide(HttpLive)))
    expect(ok.session.sid).toBe("test-sid")
    const failure = await Effect.runPromiseExit(authenticate(baseUrl, passwordForm("wrong")).pipe(Effect.provide(HttpLive)))
    expect(Exit.isFailure(failure)).toBeTrue()
    if (Exit.isFailure(failure)) expect(Cause.pretty(failure.cause)).toContain("Invalid password")
    const noAuth = await Effect.runPromiseExit(authenticate(baseUrl, { ...passwordForm(""), authMethod: "none" }).pipe(Effect.provide(HttpLive)))
    expect(Exit.isFailure(noAuth)).toBeTrue()
    if (Exit.isFailure(noAuth)) expect(Cause.pretty(noAuth.cause)).toContain("password required")
  })

  test("paginates beyond Pi-hole's 10,000-row cap without truncation", async () => {
    pageStarts.length = 0
    const connection = await Effect.runPromise(authenticate(baseUrl, passwordForm("correct")).pipe(Effect.provide(HttpLive)))
    const rows = await Effect.runPromise(fetchAllQueries(connection, spec).pipe(Effect.provide(HttpLive)))
    expect(rows).toHaveLength(total)
    expect(pageStarts).toEqual([{ start: 0, cursor: null }, { start: 10_000, cursor: "50000" }])
  }, 15_000)

  test("runs startup → auth → suggestions/filters → results → complete export", async () => {
    const path = join(temp, "complete.csv")
    const result = await Effect.runPromise(Effect.gen(function* () {
      const connection = yield* authenticate(baseUrl, passwordForm("correct"))
      const suggestions = yield* fetchSuggestions(connection)
      const rows = yield* fetchAllQueries(connection, { ...spec, domain: suggestions.domain[0] ?? "" })
      const exported = yield* writeCsv(path, rows)
      return { rows, exported }
    }).pipe(Effect.provide(Live)))
    expect(result.rows).toHaveLength(total)
    expect(result.exported.count).toBe(total)
    expect(readFileSync(path, "utf8").split("\r\n")).toHaveLength(total + 2)
  }, 15_000)

  test("posts exact deny/allow domain mutations with the active Pi-hole session", async () => {
    domainMutations.length = 0
    const connection = await Effect.runPromise(authenticate(baseUrl, passwordForm("correct")).pipe(Effect.provide(HttpLive)))
    await Effect.runPromise(mutateDomain(connection, "ads.example", "block").pipe(Effect.provide(HttpLive)))
    await Effect.runPromise(mutateDomain(connection, "safe.example", "unblock").pipe(Effect.provide(HttpLive)))
    expect(domainMutations).toEqual([
      {
        path: "/api/domains/deny/exact",
        sid: "test-sid",
        body: { domain: "ads.example", comment: "Added from Query Log", type: "deny", kind: "exact" },
      },
      {
        path: "/api/domains/allow/exact",
        sid: "test-sid",
        body: { domain: "safe.example", comment: "Added from Query Log", type: "allow", kind: "exact" },
      },
    ])

    const failure = await Effect.runPromiseExit(mutateDomain(connection, "failure.example", "block").pipe(Effect.provide(HttpLive)))
    expect(Exit.isFailure(failure)).toBeTrue()
    if (Exit.isFailure(failure)) expect(Cause.pretty(failure.cause)).toContain("Domain mutation failed")
  })

  test("streams complete CSV, JSONL, SQLite, and Parquet exports from the page primitive", async () => {
    const connection = await Effect.runPromise(authenticate(baseUrl, passwordForm("correct")).pipe(Effect.provide(HttpLive)))
    for (const format of ["csv", "jsonl", "sqlite", "parquet"] as const) {
      const path = join(temp, `streamed.${format}`)
      const result = await Effect.runPromise(exportQueryPages(path, format, streamQueryPages(connection, spec)).pipe(Effect.provide(Live)))
      expect(result.count).toBe(total)
      if (format === "csv") expect(readFileSync(path, "utf8").split("\r\n")).toHaveLength(total + 2)
      if (format === "jsonl") expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(total)
      if (format === "sqlite") {
        const database = new Database(path, { readonly: true })
        expect((database.query("SELECT count(*) AS count FROM queries").get() as { count: number }).count).toBe(total)
        database.close()
      }
      if (format === "parquet") {
        const bytes = readFileSync(path)
        expect(bytes.subarray(0, 4).toString()).toBe("PAR1")
        expect(bytes.subarray(-4).toString()).toBe("PAR1")
      }
    }
  }, 30_000)

  test("runs headless automation on the same query/export primitives", async () => {
    const path = join(temp, "headless.jsonl")
    const result = await Effect.runPromise(runHeadless([
      "--headless", "--host", baseUrl, "--auth", "password", "--from", "1970-01-01 00:00:01",
      "--until", "2033-05-18 03:33:20", "--timezone", "UTC", "--output", path, "--format", "jsonl",
    ], { PIHOLE_PASSWORD: "correct" }).pipe(Effect.provide(Live)))
    expect(result.count).toBe(total)
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(total)
    expect(readFileSync(path, "utf8")).not.toContain("correct")
  }, 15_000)

  test("reports network and write failures as typed failures", async () => {
    const network = await Effect.runPromiseExit(authenticate("http://127.0.0.1:1", passwordForm("correct")).pipe(Effect.provide(HttpLive)))
    expect(Exit.isFailure(network)).toBeTrue()
    if (Exit.isFailure(network)) expect(Cause.pretty(network.cause)).toContain("NetworkError")

    const write = await Effect.runPromiseExit(writeCsv(temp, [makeQuery(1)]).pipe(Effect.provide(BunFileSystem.layer)))
    expect(Exit.isFailure(write)).toBeTrue()
    if (Exit.isFailure(write)) expect(Cause.pretty(write.cause)).toContain("WriteError")

    const streamed = await Effect.runPromiseExit(exportQueryPages(
      join(temp, "failed.jsonl"), "jsonl", Stream.fail(new NetworkError({ message: "stream failed" })),
    ).pipe(Effect.provide(BunFileSystem.layer)))
    expect(Exit.isFailure(streamed)).toBeTrue()
    if (Exit.isFailure(streamed)) expect(Cause.pretty(streamed.cause)).toContain("NetworkError")
  })

  test("streaming export remains interruptible between pages", async () => {
    const path = join(temp, "cancelled.csv")
    const pages = Stream.concat(
      Stream.succeed({ queries: [makeQuery(1)], cursor: null, recordsFiltered: 2 }),
      Stream.never,
    )
    const fiber = Effect.runFork(exportQueryPages(path, "csv", pages).pipe(Effect.provide(BunFileSystem.layer)))
    await Bun.sleep(20)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBeTrue()
    expect(readFileSync(path, "utf8")).toContain("host-1.example")
  })

  test("Effect cancellation interrupts in-flight HTTP work", async () => {
    const request = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      yield* client.get(`${baseUrl}/slow`)
    }).pipe(Effect.provide(HttpLive))
    const fiber = Effect.runFork(request)
    await Bun.sleep(20)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit)).toBeTrue()
  })
})
