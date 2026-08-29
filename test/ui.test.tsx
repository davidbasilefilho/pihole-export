/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"

test("startup renders the credential-first compact connection screen", async () => {
  const setup = await testRender(() => <App />, { width: 120, height: 28 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("PI-HOLE EXPORT")
  expect(frame).toContain("CONNECTION")
  expect(frame).toContain("Pi-hole IP / domain / full URL")
  expect(frame).toContain("Authentication")
  expect(frame).toContain("READY")
  expect(frame).toContain("TAB NEXT │")
  expect(frame).not.toContain("FIELD                 VALUE")
  expect(frame).not.toContain("Resolved URL")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  expect(frame).not.toContain("ADVANCED FILTERING")
  setup.renderer.destroy()
})

test("connection screen remains dense and usable at 60 columns", async () => {
  const setup = await testRender(() => <App />, { width: 60, height: 18 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Pi-hole IP / domain / full URL")
  expect(frame).toContain("Authentication")
  expect(frame).toContain("CONNECT")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  setup.renderer.destroy()
})

test("initial URL field accepts full URL typing", async () => {
  const setup = await testRender(() => <App />, { width: 100, height: 20 })
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
  const frame = setup.captureCharFrame()
  expect(frame).toContain("https://dnsbox.local")
  setup.renderer.destroy()
})
