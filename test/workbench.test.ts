import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeQueries } from "../src/lib/analytics";
import { parseHeadlessOptions } from "../src/lib/headless";
import type { FilterForm, Query } from "../src/lib/model";
import { loadPresets, savePresets, upsertPreset } from "../src/lib/presets";
import { refineFiltersFromQuery, searchAndSortQueries } from "../src/lib/query";
import { formatLocalDateTimeInput } from "../src/lib/time";
import { connectControls, moveCyclic, moveIndex } from "../src/ui/focus";
import { handleWorkbenchKey, type WorkbenchKeyboard } from "../src/ui/keyboard";

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

describe("analytics", () => {
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
    expect(connectControls("none")).toEqual(["scheme", "host", "port", "auth", "connect"]);
    expect(moveCyclic(connectControls("none"), "host", -1)).toBe("scheme");
    expect(moveCyclic(connectControls("none"), "host", 1)).toBe("port");
    expect(moveIndex(0, -1, 4)).toBe(3);
    expect(moveIndex(3, 1, 4, false)).toBe(3);
  });

  test("consumes Export E before opening the focused destination input", () => {
    let prevented = false;
    let action = -1;
    let preventedBeforeTransition = false;
    handleWorkbenchKey(
      {
        screen: () => "results",
        busy: () => false,
        resultAction: (index) => {
          action = index;
          preventedBeforeTransition = prevented;
        },
      } as WorkbenchKeyboard,
      {
        name: "e",
        ctrl: false,
        shift: true,
        preventDefault: () => {
          prevented = true;
        },
      } as KeyEvent,
    );
    expect(action).toBe(5);
    expect(prevented).toBeTrue();
    expect(preventedBeforeTransition).toBeTrue();
  });

  test("routes Ctrl+B to block/unblock and supports confirmation keyboard controls", () => {
    let prevented = false;
    let action = -1;
    handleWorkbenchKey(
      {
        screen: () => "results",
        busy: () => false,
        resultAction: (index) => {
          action = index;
        },
      } as WorkbenchKeyboard,
      {
        name: "b",
        ctrl: true,
        shift: false,
        preventDefault: () => {
          prevented = true;
        },
      } as KeyEvent,
    );
    expect(action).toBe(4);
    expect(prevented).toBeTrue();

    let accepted = 0;
    let cancelled = 0;
    const modalActions = {
      screen: () => "domain-confirm",
      acceptDomainMutation: () => {
        accepted += 1;
      },
      cancelDomainMutation: () => {
        cancelled += 1;
      },
    } as WorkbenchKeyboard;
    handleWorkbenchKey(modalActions, { name: "return", ctrl: false, shift: false } as KeyEvent);
    handleWorkbenchKey(modalActions, { name: "escape", ctrl: false, shift: false } as KeyEvent);
    expect(accepted).toBe(1);
    expect(cancelled).toBe(1);

    let focusDelta = 0;
    let tabPrevented = false;
    handleWorkbenchKey(
      {
        ...modalActions,
        moveDialogFocus: (delta) => {
          focusDelta = delta;
        },
      },
      {
        name: "tab",
        ctrl: false,
        shift: true,
        preventDefault: () => {
          tabPrevented = true;
        },
      } as KeyEvent,
    );
    expect(focusDelta).toBe(-1);
    expect(tabPrevented).toBeTrue();
  });
});

describe("local timestamp input", () => {
  test("inserts separators and removes them naturally with backspace", () => {
    expect(formatLocalDateTimeInput("16")).toBe("16/");
    expect(formatLocalDateTimeInput("16", "16/")).toBe("1");
    expect(formatLocalDateTimeInput("30072026082")).toBe("30/07/2026 08:2");
    expect(formatLocalDateTimeInput("30/07/2026 08:", "30/07/2026 08:2")).toBe(
      "30/07/2026 08",
    );
    expect(formatLocalDateTimeInput("300720260")).toBe("30/07/2026 0");
    expect(formatLocalDateTimeInput("30/07/2026 ", "30/07/2026 0")).toBe("30/07/2026");
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
