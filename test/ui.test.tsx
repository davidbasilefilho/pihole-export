/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { App } from "../src/App"
import type { FilterForm } from "../src/lib/model"
import { FilterScreen } from "../src/ui/screens/FilterScreen"
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
  from: "2026-08-31 10:00:00", until: "2026-08-31 11:00:00", timezone: "UTC",
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
