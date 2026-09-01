/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { App } from "../src/App"
import type { FilterForm } from "../src/lib/model"
import type { Query } from "../src/lib/model"
import { analyzeQueries } from "../src/lib/analytics"
import { DomainActionDialog } from "../src/ui/dialogs"
import { FilterScreen } from "../src/ui/screens/FilterScreen"
import { ResultsScreen } from "../src/ui/screens/ResultsScreen"
import { Segmented } from "../src/ui/primitives"

test("startup renders the credential-first compact connection screen", async () => {
  const setup = await testRender(() => App(), { width: 120, height: 28 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("PI-HOLE EXPORT")
  expect(frame).toContain("CONNECTION")
  expect(frame).toContain("Pi-hole IP / domain / full URL")
  expect(frame).toContain("AUTHENTICATION")
  expect(frame).toContain("READY")
  expect(frame).toContain("TAB NEXT │")
  expect(frame).not.toContain("FIELD                 VALUE")
  expect(frame).not.toContain("Resolved URL")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  expect(frame).not.toContain("ADVANCED FILTERING")
  setup.renderer.destroy()
})

test("connection screen remains dense and usable at 60 columns", async () => {
  const setup = await testRender(() => App(), { width: 60, height: 18 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Pi-hole IP / domain / full URL")
  expect(frame).toContain("AUTHENTICATION")
  expect(frame).toContain("CONNECT")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  setup.renderer.destroy()
})

test("initial URL field accepts full URL typing", async () => {
  const setup = await testRender(() => App(), { width: 100, height: 20 })
  await setup.renderOnce()
  expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(InputRenderable)
  let observed = ""
  if (setup.renderer.currentFocusedRenderable instanceof InputRenderable) {
    expect(setup.renderer.currentFocusedRenderable.listenerCount("input")).toBeGreaterThan(0)
    setup.renderer.currentFocusedRenderable.on("input", (value) => { observed = value })
  }
  await setup.mockInput.typeText("https://dnsbox.local")
  expect(observed).toBe("https://dnsbox.local")
  if (setup.renderer.currentFocusedRenderable instanceof InputRenderable) {
    expect(setup.renderer.currentFocusedRenderable.value).toBe("https://dnsbox.local")
  }
  await setup.renderOnce()
  setup.renderer.destroy()
})

function SegmentHarness(props: { initial?: "password" | "session" | "none" } = {}) {
  const [value, setValue] = createSignal<"password" | "session" | "none">(props.initial ?? "password")
  return <box width={60} height={4} flexDirection="column"><Segmented label="Method" values={["password", "session", "none"]} value={value()} focused onFocus={() => {}} onSelect={setValue} /><text>selected:{value()}</text></box>
}

test("segmented controls render centered labels and selected state", async () => {
  const setup = await testRender(() => SegmentHarness({ initial: "session" }), { width: 60, height: 6 })
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("selected:session")
    const options = setup.captureCharFrame().split("\n")[1] ?? ""
    expect(options.indexOf("PASSWORD")).toBeGreaterThan(0)
    expect(options.indexOf("SESSION")).toBeGreaterThan(options.indexOf("PASSWORD"))
    expect(options.indexOf("NONE")).toBeGreaterThan(options.indexOf("SESSION"))
  } finally {
    setup.renderer.destroy()
  }
})

const initialFilters: FilterForm = {
  from: "31/08/2026 10:00:00", until: "31/08/2026 11:00:00", timezone: "UTC",
  disk: false, domain: "", clientIp: "", clientName: "", upstream: "", type: "",
  status: "", reply: "", dnssec: "",
}

function FilterHarness(props: { width: number }) {
  const [filters, setFilters] = createStore({ ...initialFilters })
  return <box width="100%" height="100%"><FilterScreen width={props.width} filters={filters} setFilters={setFilters} focus={0} busy={false} onFocus={() => {}} onPresets={() => {}} onSubmit={() => {}} /></box>
}

test("filter layout groups scan cleanly at wide and narrow terminal sizes", async () => {
  for (const size of [{ width: 120, height: 28 }, { width: 60, height: 44 }]) {
    const setup = await testRender(() => <FilterHarness width={size.width} />, size)
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("DATE · TIME · TIMEZONE")
      expect(frame).toContain("DOMAIN · CLIENT · UPSTREAM")
      expect(frame).toContain("DNS PROPERTIES")
      expect(frame).toContain("MODE · QUERY ACTION")
      expect(frame).toContain("ON-DISK: OFF")
      if (size.width >= 80) expect(frame).toContain("FETCH QUERIES")
      else {
        for (let index = 0; index < 8; index += 1)
          await setup.mockMouse.scroll(30, 40, "down")
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain("FETCH QUERIES")
      }
    } finally {
      setup.renderer.destroy()
    }
  }
})

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
})

function ResultsHarness(props: { row: Query }) {
  return <ResultsScreen
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
}

test("blocked result rows use Tokyo Night red while retaining selected-row contrast", async () => {
  const setup = await testRender(() => <ResultsHarness row={resultQuery("GRAVITY")} />, { width: 120, height: 24 })
  try {
    await setup.renderOnce()
    const line = setup.captureSpans().lines.find((candidate) =>
      candidate.spans.some((span) => span.text.includes("ads.example")),
    )
    const domain = line?.spans.find((span) => span.text.includes("ads.example"))
    expect(domain?.fg.toInts()).toEqual([247, 118, 142, 255])
    expect(domain?.bg.toInts()).toEqual([61, 89, 161, 255])
    expect(setup.captureCharFrame()).toContain("> ")
  } finally {
    setup.renderer.destroy()
  }
})

test("results action follows the selected query's BLOCK/UNBLOCK semantics", async () => {
  for (const [status, label] of [["FORWARDED", "BLOCK"], ["DENYLIST", "UNBLOCK"]] as const) {
    const setup = await testRender(() => <ResultsHarness row={resultQuery(status)} />, { width: 120, height: 24 })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain(label)
      if (label === "BLOCK") expect(frame).not.toContain("UNBLOCK")
    } finally {
      setup.renderer.destroy()
    }
  }
})

test("domain mutation requires the explicit confirmation control", async () => {
  let confirmations = 0
  let cancellations = 0
  const setup = await testRender(() => <DomainActionDialog
    domain="ads.example"
    action="block"
    focus={0}
    onFocus={() => {}}
    onConfirm={() => { confirmations += 1 }}
    onCancel={() => { cancellations += 1 }}
  />, { width: 80, height: 16 })
  try {
    await setup.renderOnce()
    expect(confirmations).toBe(0)
    const lines = setup.captureCharFrame().split("\n")
    const confirmY = lines.findIndex((line) => line.includes("CONFIRM BLOCK"))
    const confirmX = lines[confirmY]?.indexOf("CONFIRM BLOCK") ?? -1
    expect(confirmY).toBeGreaterThanOrEqual(0)
    expect(confirmX).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(confirmX, confirmY)
    expect(confirmations).toBe(1)
    expect(cancellations).toBe(0)
  } finally {
    setup.renderer.destroy()
  }
})

test("cancelling the domain confirmation never invokes the mutation callback", async () => {
  let confirmations = 0
  let cancellations = 0
  const setup = await testRender(() => <DomainActionDialog
    domain="safe.example"
    action="unblock"
    focus={1}
    onFocus={() => {}}
    onConfirm={() => { confirmations += 1 }}
    onCancel={() => { cancellations += 1 }}
  />, { width: 80, height: 16 })
  try {
    await setup.renderOnce()
    const lines = setup.captureCharFrame().split("\n")
    const cancelY = lines.findIndex((line) => line.includes("CANCEL"))
    const cancelX = lines[cancelY]?.indexOf("CANCEL") ?? -1
    await setup.mockMouse.click(cancelX, cancelY)
    expect(confirmations).toBe(0)
    expect(cancellations).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})
