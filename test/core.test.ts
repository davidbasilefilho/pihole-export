import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { toCsv } from "../src/lib/export"
import { QueryResponse } from "../src/lib/model"
import { baseUrl, needsHeavyQueryConfirmation, serializeQuery, toQuerySpec, type QuerySpec } from "../src/lib/query"
import { localToEpochSeconds } from "../src/lib/time"

const spec: QuerySpec = {
  from: 1_000,
  until: 2_000,
  disk: true,
  domain: "*.example.com",
  clientIp: "10.0.*",
  clientName: "phone*",
  upstream: "1.1.1.1#53",
  type: "AAAA",
  status: "FORWARDED",
  reply: "IP",
  dnssec: "SECURE",
}

const query = {
  id: 42,
  time: 1_700_000_000.25,
  type: "A",
  domain: "a,\"quoted\".example",
  cname: "alias.example",
  status: "FORWARDED",
  client: { ip: "10.0.0.2", name: "desk\ntop" },
  dnssec: "SECURE",
  reply: { type: "IP", time: 1.25 },
  list_id: null,
  upstream: "1.1.1.1#53",
  ede: { code: 0, text: null },
}

describe("query construction", () => {
  test("normalizes IP/domain/full URL input without duplicating Pi-hole API paths", async () => {
    const common = { scheme: "http" as const, port: "", authMethod: "none" as const, secret: "", totp: "" }
    expect(await Effect.runPromise(baseUrl({ ...common, host: "10.200.0.242" }))).toBe("http://10.200.0.242")
    expect(await Effect.runPromise(baseUrl({ ...common, host: "https://pi.hole/api/" }))).toBe("https://pi.hole")
  })
  test("serializes every Pi-hole filter and stable pagination", () => {
    const params = serializeQuery(spec, 10_000, 77)
    expect(Object.fromEntries(params)).toEqual({
      from: "1000", until: "2000", disk: "true", length: "10000", start: "10000",
      domain: "*.example.com", client_ip: "10.0.*", client_name: "phone*",
      upstream: "1.1.1.1#53", type: "AAAA", status: "FORWARDED", reply: "IP",
      dnssec: "SECURE", cursor: "77",
    })
  })

  test("keeps independent filters combinable and omits only empty values", () => {
    const params = serializeQuery({ ...spec, domain: "", type: "", dnssec: "" })
    expect(params.has("domain")).toBeFalse()
    expect(params.get("client_ip")).toBe("10.0.*")
    expect(params.get("status")).toBe("FORWARDED")
    expect(params.has("cursor")).toBeFalse()
  })

  test("warns only for date-only ranges over 48 hours", () => {
    const dateOnly = { ...spec, disk: true, domain: "", clientIp: "", clientName: "", upstream: "", type: "", status: "", reply: "", dnssec: "" }
    expect(needsHeavyQueryConfirmation({ ...dateOnly, until: dateOnly.from + 48 * 60 * 60 })).toBeFalse()
    expect(needsHeavyQueryConfirmation({ ...dateOnly, until: dateOnly.from + 48 * 60 * 60 + 1 })).toBeTrue()
    expect(needsHeavyQueryConfirmation({ ...dateOnly, until: dateOnly.from + 72 * 60 * 60, domain: "example.com" })).toBeFalse()
  })
})

describe("time boundaries", () => {
  test("converts human local values in an explicit timezone", async () => {
    const result = await Effect.runPromise(localToEpochSeconds("29/08/2026 12:00:00", "America/Sao_Paulo"))
    expect(result).toBe(Date.parse("2026-08-29T15:00:00Z") / 1000)
  })

  test("rejects nonexistent DST local times", async () => {
    const exit = await Effect.runPromiseExit(localToEpochSeconds("08/03/2026 02:30:00", "America/New_York"))
    expect(Exit.isFailure(exit)).toBeTrue()
  })

  test("converts client-formatted timestamps before API serialization", async () => {
    const converted = await Effect.runPromise(toQuerySpec({
      from: "29/08/2026 12:00:00", until: "29/08/2026 13:00:00", timezone: "America/Sao_Paulo",
      disk: false, domain: "", clientIp: "", clientName: "", upstream: "", type: "",
      status: "", reply: "", dnssec: "",
    }))
    const params = serializeQuery(converted)
    expect(params.get("from")).toBe(String(Date.parse("2026-08-29T15:00:00Z") / 1000))
    expect(params.get("until")).toBe(String(Date.parse("2026-08-29T16:00:00Z") / 1000))
    expect(params.toString()).not.toContain("29%2F08%2F2026")
  })

  test("rejects impossible calendar dates", async () => {
    const exit = await Effect.runPromiseExit(localToEpochSeconds("31/02/2026 12:00:00", "UTC"))
    expect(Exit.isFailure(exit)).toBeTrue()
  })

  test("preserves Pi-hole from-inclusive/until-exclusive values exactly", () => {
    const params = serializeQuery({ ...spec, from: 123.125, until: 456.875 })
    expect(params.get("from")).toBe("123.125")
    expect(params.get("until")).toBe("456.875")
  })
})

describe("runtime schemas and CSV", () => {
  test("decodes a current Pi-hole query response and rejects malformed JSON shapes", async () => {
    const valid = { queries: [query], cursor: 42, recordsTotal: 1, recordsFiltered: 1, draw: 0, earliest_timestamp: 1, earliest_timestamp_disk: 1 }
    expect((await Effect.runPromise(Schema.decodeUnknown(QueryResponse)(valid))).queries).toHaveLength(1)
    const invalid = await Effect.runPromiseExit(Schema.decodeUnknown(QueryResponse)({ ...valid, queries: [{ ...query, time: "bad" }] }))
    expect(Exit.isFailure(invalid)).toBeTrue()
  })

  test("writes UTF-8 RFC-style CSV quoting and all useful raw fields", () => {
    const csv = toCsv([query])
    expect(csv).toStartWith("timestamp,time_iso,domain,client_ip,client_name,type,status,reply")
    expect(csv).toContain('"a,""quoted"".example"')
    expect(csv).toContain('"desk\ntop"')
    expect(csv).toEndWith("\r\n")
  })
})
