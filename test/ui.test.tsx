/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";

import { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { App } from "../src/App";
import { analyzeQueries } from "../src/lib/analytics";
import type { FilterForm } from "../src/lib/model";
import type { Query } from "../src/lib/model";
import { DomainActionDialog } from "../src/ui/dialogs";
import { Field, Segmented } from "../src/ui/primitives";
import { FilterScreen } from "../src/ui/screens/FilterScreen";
import { ResultsScreen } from "../src/ui/screens/ResultsScreen";

test("startup renders the credential-first compact connection screen", async () => {
  const setup = await testRender(() => App(), { width: 120, height: 28 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("PI-HOLE EXPORT");
  expect(frame).toContain("CONNECTION");
  expect(frame).toContain("Pi-hole IP / domain / full URL");
  expect(frame).toContain("AUTHENTICATION");
  expect(frame).toContain("READY");
  expect(frame).toContain("TAB NEXT │");
  expect(frame).not.toContain("FIELD                 VALUE");
  expect(frame).not.toContain("Resolved URL");
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/);
  expect(frame).not.toContain("ADVANCED FILTERING");
  setup.renderer.destroy();
});

test("connection screen remains dense and usable at 60 columns", async () => {
  const setup = await testRender(() => App(), { width: 60, height: 18 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Pi-hole IP / domain / full URL");
  expect(frame).toContain("AUTHENTICATION");
  expect(frame).toContain("CONNECT");
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/);
  setup.renderer.destroy();
});

test("initial URL field accepts full URL typing", async () => {
  const setup = await testRender(() => App(), { width: 100, height: 20 });
  await setup.renderOnce();
  expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable);
  let observed = "";
  if (setup.renderer.currentFocusedRenderable instanceof InputRenderable) {
    expect(setup.renderer.currentFocusedRenderable.listenerCount("input")).toBeGreaterThan(0);
    setup.renderer.currentFocusedRenderable.on("input", (value) => {
      observed = value;
    });
  }
  await setup.mockInput.typeText("https://dnsbox.local");
  expect(observed).toBe("https://dnsbox.local");
  if (setup.renderer.currentFocusedRenderable instanceof InputRenderable) {
    expect(setup.renderer.currentFocusedRenderable.value).toBe("https://dnsbox.local");
  }
  await setup.renderOnce();
  setup.renderer.destroy();
});

function SegmentHarness(props: { initial?: "password" | "session" | "none" } = {}) {
  const [value, setValue] = createSignal<"password" | "session" | "none">(
    props.initial ?? "password",
  );
  return (
    <box width={60} height={4} flexDirection="column">
      <Segmented
        label="Method"
        values={["password", "session", "none"]}
        value={value()}
        focused
        onFocus={() => {}}
        onSelect={setValue}
      />
      <text>selected:{value()}</text>
    </box>
  );
}

test("segmented controls render centered labels and selected state", async () => {
  const setup = await testRender(() => SegmentHarness({ initial: "session" }), {
    width: 60,
    height: 6,
  });
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("selected:session");
    const options = setup.captureCharFrame().split("\n")[1] ?? "";
    expect(options.indexOf("PASSWORD")).toBeGreaterThan(0);
    expect(options.indexOf("SESSION")).toBeGreaterThan(options.indexOf("PASSWORD"));
    expect(options.indexOf("NONE")).toBeGreaterThan(options.indexOf("SESSION"));
  } finally {
    setup.renderer.destroy();
  }
});

const initialFilters: FilterForm = {
  from: "31/08/2026 10:00:00",
  until: "31/08/2026 11:00:00",
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

function FilterHarness(props: { width: number }) {
  const [filters, setFilters] = createStore({ ...initialFilters });
  return (
    <box width="100%" height="100%">
      <FilterScreen
        width={props.width}
        filters={filters}
        setFilters={setFilters}
        focus={0}
        busy={false}
        onFocus={() => {}}
        onPresets={() => {}}
        onSubmit={() => {}}
        onExport={() => {}}
      />
    </box>
  );
}

test("filter layout groups scan cleanly at wide and narrow terminal sizes", async () => {
  for (const size of [
    { width: 120, height: 28 },
    { width: 60, height: 44 },
  ]) {
    const setup = await testRender(() => <FilterHarness width={size.width} />, size);
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("DATE · TIME · TIMEZONE");
      expect(frame).toContain("DOMAIN · CLIENT · UPSTREAM");
      expect(frame).toContain("DNS PROPERTIES");
      expect(frame).toContain("MODE · QUERY ACTION");
      expect(frame).toContain("API DISK: OFF");
      if (size.width >= 80) expect(frame).toContain("FETCH QUERIES");
      else {
        for (let index = 0; index < 8; index += 1) await setup.mockMouse.scroll(30, 40, "down");
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("FETCH QUERIES");
      }
    } finally {
      setup.renderer.destroy();
    }
  }
});

const resultQuery = (status: string | null): Query => ({
  id: 1,
  time: 1_700_000_000,
  type: "A",
  domain: "ads.example",
  cname: null,
  status,
  client: { ip: "10.0.0.2", name: "desktop" },
  dnssec: "INSECURE",
  reply: { type: "IP", time: 2 },
  list_id: null,
  upstream: "1.1.1.1#53",
  ede: { code: 0, text: null },
});

function ResultsHarness(props: { row: Query }) {
  return (
    <ResultsScreen
      width={120}
      height={24}
      rows={[props.row]}
      selected={0}
      busy={false}
      aggregate={false}
      analytics={analyzeQueries([props.row])}
      search=""
      sort="time-desc"
      actionFocus={0}
      onActionFocus={() => {}}
      onAction={() => {}}
      onSelect={() => {}}
      onInspect={() => {}}
      onMove={() => {}}
    />
  );
}

test("blocked result rows use Tokyo Night red while retaining selected-row contrast", async () => {
  const setup = await testRender(() => <ResultsHarness row={resultQuery("GRAVITY")} />, {
    width: 120,
    height: 24,
  });
  try {
    await setup.renderOnce();
    const line = setup
      .captureSpans()
      .lines.find((candidate) => candidate.spans.some((span) => span.text.includes("ads.example")));
    const domain = line?.spans.find((span) => span.text.includes("ads.example"));
    expect(domain?.fg.toInts()).toEqual([247, 118, 142, 255]);
    expect(domain?.bg.toInts()).toEqual([61, 89, 161, 255]);
    expect(setup.captureCharFrame()).toContain("> ");
  } finally {
    setup.renderer.destroy();
  }
});

test("results action follows the selected query's BLOCK/UNBLOCK semantics", async () => {
  for (const [status, label] of [
    ["FORWARDED", "BLOCK"],
    ["DENYLIST", "UNBLOCK"],
  ] as const) {
    const setup = await testRender(() => <ResultsHarness row={resultQuery(status)} />, {
      width: 120,
      height: 24,
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain(label);
      if (label === "BLOCK") expect(frame).not.toContain("UNBLOCK");
    } finally {
      setup.renderer.destroy();
    }
  }
});

test("domain mutation requires the explicit confirmation control", async () => {
  let confirmations = 0;
  let cancellations = 0;
  const setup = await testRender(
    () => (
      <DomainActionDialog
        domain="ads.example"
        action="block"
        focus={0}
        onFocus={() => {}}
        onConfirm={() => {
          confirmations += 1;
        }}
        onCancel={() => {
          cancellations += 1;
        }}
      />
    ),
    { width: 80, height: 16 },
  );
  try {
    await setup.renderOnce();
    expect(confirmations).toBe(0);
    const lines = setup.captureCharFrame().split("\n");
    const confirmY = lines.findIndex((line) => line.includes("CONFIRM BLOCK"));
    const confirmX = lines[confirmY]?.indexOf("CONFIRM BLOCK") ?? -1;
    expect(confirmY).toBeGreaterThanOrEqual(0);
    expect(confirmX).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(confirmX, confirmY);
    expect(confirmations).toBe(1);
    expect(cancellations).toBe(0);
  } finally {
    setup.renderer.destroy();
  }
});

test("cancelling the domain confirmation never invokes the mutation callback", async () => {
  let confirmations = 0;
  let cancellations = 0;
  const setup = await testRender(
    () => (
      <DomainActionDialog
        domain="safe.example"
        action="unblock"
        focus={1}
        onFocus={() => {}}
        onConfirm={() => {
          confirmations += 1;
        }}
        onCancel={() => {
          cancellations += 1;
        }}
      />
    ),
    { width: 80, height: 16 },
  );
  try {
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const cancelY = lines.findIndex((line) => line.includes("CANCEL"));
    const cancelX = lines[cancelY]?.indexOf("CANCEL") ?? -1;
    await setup.mockMouse.click(cancelX, cancelY);
    expect(confirmations).toBe(0);
    expect(cancellations).toBe(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("date field clears once per focus entry and password bracketed paste stays masked", async () => {
  let value = "01/09/2026";
  const setup = await testRender(
    () => (
      <Field
        label="Date"
        value={value}
        focused
        clearOnFocus
        onFocus={() => {}}
        onInput={(v) => {
          value = v;
        }}
      />
    ),
    { width: 80, height: 8 },
  );
  await setup.renderOnce();
  expect(value).toBe("");
  const input = setup.renderer.currentFocusedRenderable as InputRenderable;
  await setup.mockInput.typeText("02/09/2026");
  await setup.renderOnce();
  expect(value).toBe("02/09/2026");
  input.focus();
  await setup.renderOnce();
  expect(value).toBe("02/09/2026");
  input.blur();
  input.focus();
  await setup.renderOnce();
  expect(value).toBe("");
  setup.renderer.destroy();
  const [secret, setSecret] = createSignal("");
  const password = await testRender(
    () => (
      <Field
        label="Password"
        secret
        value={secret()}
        focused
        onFocus={() => {}}
        onInput={setSecret}
      />
    ),
    { width: 80, height: 8 },
  );
  await password.renderOnce();
  password.renderer.keyInput.processPaste(new TextEncoder().encode("synthetic-password"));
  await password.renderOnce();
  expect(secret()).toBe("synthetic-password");
  expect(password.captureCharFrame()).not.toContain("synthetic-password");
  password.renderer.destroy();
});

test("export dialog keeps elapsed time and cancellation visible while waiting", async () => {
  const { ExportDialog } = await import("../src/ui/dialogs");
  let busy = true;
  let phase: "waiting" | "writing" | "finalizing" = "waiting";
  let rows = 0;
  let error = "";
  const setup = await testRender(
    () =>
      ExportDialog({
        path: "synthetic.csv",
        format: "csv",
        focus: 3,
        get busy() {
          return busy;
        },
        get progress() {
          return { phase, rows };
        },
        get error() {
          return error;
        },
        onFocus: () => {},
        onPath: () => {},
        onFormat: () => {},
        onExport: () => {},
        onCancel: () => {},
      }),
    { width: 140, height: 20 },
  );
  await Bun.sleep(1100);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("1s elapsed");
  expect(setup.captureCharFrame()).toContain("Waiting for Pi-hole response");
  expect(setup.captureCharFrame()).toContain("CANCEL");
  phase = "writing";
  await Bun.sleep(220);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Writing received batch");
  phase = "finalizing";
  rows = 1;
  await Bun.sleep(220);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("1 rows processed");
  busy = false;
  error = "Network request timed out";
  await Bun.sleep(220);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain(error);
  setup.renderer.destroy();
});
