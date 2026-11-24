#!/usr/bin/env bun
/** @jsxImportSource @opentui/solid */
import { render } from "@opentui/solid";
import { Effect } from "effect";

import { App } from "./App";
import { headlessUsage, isHeadlessInvocation, runHeadless } from "./lib/headless";
import { runOffline } from "./lib/offline";
import { runtime } from "./lib/runtime";

const args = process.argv.slice(2);

if (args.includes("--offline")) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  Effect.runPromise(runOffline(args), { signal: controller.signal })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`pihole-export offline: ${String(error)}\n`);
      process.exitCode = 1;
    });
} else if (isHeadlessInvocation(args)) {
  runtime
    .runPromise(runHeadless(args))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`pihole-export: ${String(error)}\n\n${headlessUsage}\n`);
      process.exitCode = 1;
    });
} else {
  Effect.runFork(
    Effect.tryPromise({
      try: () => render(() => <App />, { exitOnCtrlC: false }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => process.stderr.write(`pihole-export: ${String(error)}\n`)),
      ),
    ),
  );
}
