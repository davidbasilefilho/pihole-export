#!/usr/bin/env bun
/** @jsxImportSource @opentui/solid */
import { render } from "@opentui/solid";
import { Effect } from "effect";

import { App } from "./App";

Effect.runFork(
  Effect.tryPromise({
    try: () => render(() => <App />, { exitOnCtrlC: false }),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => process.stderr.write(`pihole-export: ${String(error)}\n`)),
    ),
  ),
);
