import { expect, test } from "bun:test";

import type { KeyEvent } from "@opentui/core";
import { Effect } from "effect";

import {
  prepareFilterRequest,
  dispatchFilterRequest,
  type FilterRequest,
} from "../src/lib/filter-action";
import { handleWorkbenchKey, type WorkbenchKeyboard } from "../src/ui/keyboard";

const filters = {
  from: "01/09/2026 00:00:00",
  until: "04/09/2026 00:00:00",
  timezone: "UTC",
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

test("long filtered and unfiltered requests are blocked before dispatch", async () => {
  for (const domain of ["", "synthetic.example"]) {
    await expect(
      Effect.runPromise(prepareFilterRequest({ ...filters, domain }, "export")),
    ).rejects.toThrow("48 hours are blocked");
  }
});

test("direct export preserves every filter and normal queries keep their action", async () => {
  const selected = {
    ...filters,
    until: "02/09/2026 00:00:00",
    domain: "*.example",
    clientIp: "192.0.2.1",
    clientName: "desk",
    upstream: "192.0.2.53",
    type: "A",
    status: "FORWARDED",
    reply: "IP",
    dnssec: "SECURE",
  };
  const calls: string[] = [];
  const handlers = {
    confirm: () => {
      calls.push("confirm");
    },
    query: () => {
      calls.push("query");
    },
    export: (spec: FilterRequest["spec"]) => {
      expect(spec).toEqual({ ...selected, from: 1788220800, until: 1788307200 });
      calls.push("export");
    },
  };
  dispatchFilterRequest(
    await Effect.runPromise(prepareFilterRequest(selected, "export")),
    handlers,
  );
  dispatchFilterRequest(await Effect.runPromise(prepareFilterRequest(selected, "query")), handlers);
  expect(calls).toEqual(["export", "query"]);
  await expect(
    Effect.runPromise(prepareFilterRequest({ ...filters, until: filters.from }, "export")),
  ).rejects.toThrow();
});

test("keyboard activates direct export without submitting a table query", () => {
  const calls: string[] = [];
  handleWorkbenchKey(
    {
      screen: () => "filters",
      filterFocus: () => 14,
      exportFilters: () => {
        calls.push("export");
      },
      submitFilters: () => {
        calls.push("query");
      },
    } as WorkbenchKeyboard,
    {
      name: "return",
      ctrl: false,
      preventDefault: () => {
        calls.push("consume");
      },
    } as KeyEvent,
  );
  expect(calls).toEqual(["consume", "export"]);
});

test("confirmation consumes Enter before opening the destination input", () => {
  const calls: string[] = [];
  handleWorkbenchKey(
    {
      screen: () => "confirm",
      acceptConfirm: () => {
        calls.push("confirm");
      },
    } as WorkbenchKeyboard,
    {
      name: "return",
      ctrl: false,
      preventDefault: () => {
        calls.push("consume");
      },
    } as KeyEvent,
  );
  expect(calls).toEqual(["consume", "confirm"]);
});
