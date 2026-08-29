/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/App"

test("startup renders the credential-first compact connection screen", async () => {
  const setup = await testRender(() => <App />, { width: 120, height: 28 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("PI-HOLE EXPORT")
  expect(frame).toContain("CONNECTION")
  expect(frame).toContain("Pi-hole IP / domain / URL")
  expect(frame).not.toContain("ADVANCED FILTERING")
  setup.renderer.destroy()
})
