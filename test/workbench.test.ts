import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeQueries } from "../src/lib/analytics";
import { deduplicateLiveRows, liveQuerySpec } from "../src/lib/api";
import { parseHeadlessOptions } from "../src/lib/headless";
import type { FilterForm, Query } from "../src/lib/model";
import { loadPresets, savePresets, upsertPreset } from "../src/lib/presets";
import { refineFiltersFromQuery, searchAndSortQueries } from "../src/lib/query";
import { connectControls, moveCyclic, moveIndex } from "../src/ui/focus";

const makeQuery = (id: number, overrides: Partial<Query> = {}): Query => ({
  id,
  time: 1_700_000_000 + id,
  type: "A",
  domain: `host-${id}.example`,
  cname: null,
  status: "FORWARDED",
  client: { ip: `10.0.0.${id}`, name: id % 2 === 0 ? "desktop" : null },
  dnssec: "INSECURE",
  reply: { type: "IP", time: 2 },
  list_id: null,
  upstream: "1.1.1.1#53",
  ede: { code: 0, text: null },
  ...overrides,
});

const filters: FilterForm = {
  from: "2026-08-31 10:00:00",
  until: "2026-08-31 11:00:00",
  timezone: "UTC",
  disk: false,
  domain: "",
  clientIp: "",
  clientName: "",
  upstream: "",
  type: "",
  status: "",
  reply: "",
  dnssec: "",
};

describe("live mode and analytics", () => {
  test("deduplicates repeated live polls by stable query identity", () => {
    const seen = new Set<string>();
    const first = [makeQuery(1), makeQuery(2)];
    expect(deduplicateLiveRows(seen, first).map((row) => row.id)).toEqual([1, 2]);
    expect(deduplicateLiveRows(seen, [makeQuery(2), makeQuery(3)]).map((row) => row.id)).toEqual([
      3,
    ]);
  });

  test("advances the live query upper boundary on every poll and disables disk mode", () => {
    const spec = {
      from: 100,
      until: 200,
      disk: true,
      domain: "",
      clientIp: "",
      clientName: "",
      upstream: "",
      type: "",
      status: "",
      reply: "",
      dnssec: "",
    };
    expect(liveQuerySpec(spec, () => 500_000)).toMatchObject({ until: 501, disk: false });
    expect(liveQuerySpec(spec, () => 700_000)).toMatchObject({ until: 701, disk: false });
  });

  test("computes blocked/allowed totals and ranked aggregates", () => {
    const rows = [
      makeQuery(1, { domain: "blocked.example", status: "GRAVITY" }),
      makeQuery(2, { domain: "allowed.example" }),
      makeQuery(3, { domain: "blocked.example", status: "REGEX" }),
    ];
    const analytics = analyzeQueries(rows);
    expect(analytics.blocked).toBe(2);
    expect(analytics.allowed).toBe(1);
    expect(analytics.blockedPercentage).toBeCloseTo(66.666, 2);
    expect(analytics.domains[0]).toMatchObject({ value: "blocked.example", count: 2 });
  });
});

describe("result workbench", () => {
  test("searches locally, sorts deterministically, and refines server filters", () => {
    const rows = [makeQuery(1), makeQuery(2, { domain: "zebra.example" })];
    expect(searchAndSortQueries(rows, "desktop", "time-desc").map((row) => row.id)).toEqual([
      2,
    ]);
    expect(searchAndSortQueries(rows, "", "domain").map((row) => row.domain)).toEqual([
      "host-1.example",
      "zebra.example",
    ]);
    expect(refineFiltersFromQuery(filters, rows[1]!, "domain").domain).toBe("zebra.example");
    expect(refineFiltersFromQuery(filters, rows[1]!, "clientIp").clientIp).toBe("10.0.0.2");
  });

  test("uses one cyclic focus model for keyboard and mouse-owned controls", () => {
    expect(connectControls("none")).toEqual(["host", "scheme", "port", "auth", "connect"]);
    expect(moveCyclic(connectControls("none"), "host", 1)).toBe("scheme");
    expect(moveIndex(0, -1, 4)).toBe(3);
    expect(moveIndex(3, 1, 4, false)).toBe(3);
  });
});

describe("presets and headless boundaries", () => {
  test("persists only the typed filter/query configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pihole-preset-test-"));
    const path = join(directory, "presets.json");
    try {
      const presets = upsertPreset([], "Audit", { ...filters, domain: "example.com" });
      await Effect.runPromise(savePresets(path, presets).pipe(Effect.provide(BunFileSystem.layer)));
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("password");
      expect(text).not.toContain("totp");
      expect(text).not.toContain("sid");
      const loaded = await Effect.runPromise(
        loadPresets(path).pipe(Effect.provide(BunFileSystem.layer)),
      );
      expect(loaded).toEqual(presets);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("parses headless automation without accepting secret command flags", async () => {
    const options = await Effect.runPromise(
      parseHeadlessOptions(
        ["--headless", "--host", "pi.hole", "--output", "queries.jsonl", "--format", "jsonl"],
        { PIHOLE_PASSWORD: "memory-only" },
      ),
    );
    expect(options.connection.secret).toBe("memory-only");
    expect(options.output).toBe("queries.jsonl");
    const rejected = await Effect.runPromiseExit(
      parseHeadlessOptions(
        ["--headless", "--host", "pi.hole", "--output", "x.csv", "--password", "leak"],
        {},
      ),
    );
    expect(rejected._tag).toBe("Failure");
  });
});
