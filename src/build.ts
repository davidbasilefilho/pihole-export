import { rm, readFile } from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";
import { Console, Effect } from "effect";

const outdir = "bin";
const outfile = `${outdir}/pihole-export`;

const build = Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () => rm(outdir, { recursive: true, force: true }),
    catch: (cause) => new Error(`Failed to clean ${outdir}: ${String(cause)}`),
  });

  const backendBytes = yield* Effect.tryPromise(() =>
    readFile(`target/release/pihole-backend${process.platform === "win32" ? ".exe" : ""}`),
  );
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: ["src/index.tsx"],
        target: "bun",
        format: "esm",
        plugins: [solidPlugin],
        compile: {
          outfile,
          autoloadBunfig: false,
          autoloadDotenv: false,
          autoloadPackageJson: false,
          autoloadTsconfig: false,
        },
        minify: true,
        bytecode: true,
        treeShaking: true,
        sourcemap: "none",
        define: {
          __EMBEDDED_BACKEND__: JSON.stringify(backendBytes.toString("base64")),
          "process.env.NODE_ENV": JSON.stringify("production"),
          "process.env.OPENTUI_LIBC": JSON.stringify(process.env.OPENTUI_LIBC ?? "glibc"),
        },
      }),
    catch: (cause) =>
      cause instanceof AggregateError
        ? new Error(cause.errors.map(String).join("\n"))
        : new Error(String(cause)),
  });

  yield* Console.log(`Built ${result.outputs[0]?.path ?? outfile}`);
});

Effect.runPromise(build).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
