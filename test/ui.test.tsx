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
  expect(frame).toContain("Endpoint")
  expect(frame).toContain("Authentication")
  expect(frame).toContain("Resolved URL")
  expect(frame).toContain("READY")
  expect(frame).toContain("TAB NEXT │")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  expect(frame).not.toContain("ADVANCED FILTERING")
  setup.renderer.destroy()
})

test("connection screen remains dense and usable at 60 columns", async () => {
  const setup = await testRender(() => <App />, { width: 60, height: 18 })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Endpoint")
  expect(frame).toContain("Authentication")
  expect(frame).toContain("CONNECT")
  expect(frame).not.toMatch(/[┌┐└┘├┤┬┴┼─]/)
  setup.renderer.destroy()
})
