import { rm } from "node:fs/promises";

import { Console, Effect } from "effect";

const outdir = "bin";
const outfile = `${outdir}/pihole-export`;

const build = Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () => rm(outdir, { recursive: true, force: true }),
    catch: (cause) => new Error(`Failed to clean ${outdir}: ${String(cause)}`),
  });

  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: ["src/index.tsx"],
        target: "bun",
        format: "esm",
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
          "process.env.NODE_ENV": JSON.stringify("production"),
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
