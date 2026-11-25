import { rm, readFile, copyFile } from "node:fs/promises";

import solidPlugin from "@opentui/solid/bun-plugin";
import { Console, Effect } from "effect";

const outdir = "bin";
const outfile = `${outdir}/${process.platform === "win32" ? "pihole-frontend" : "pihole-export"}`;

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
          __EMBEDDED_BACKEND__:
            process.platform === "win32"
              ? "undefined"
              : JSON.stringify(backendBytes.toString("base64")),
          __NATIVE_WINDOWS__: JSON.stringify(process.platform === "win32"),
          "process.env.NODE_ENV": JSON.stringify("production"),
          "process.env.OPENTUI_LIBC": JSON.stringify(process.env.OPENTUI_LIBC ?? "glibc"),
        },
      }),
    catch: (cause) =>
      cause instanceof AggregateError
        ? new Error(cause.errors.map(String).join("\n"))
        : new Error(String(cause)),
  });

  if (process.platform === "win32") {
    const build = Bun.spawn(["cargo", "build", "--release", "-p", "pihole-launcher", "--locked"], {
      env: { ...process.env, PIHOLE_FRONTEND_PAYLOAD: `${process.cwd()}/bin/pihole-frontend.exe` },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((yield* Effect.promise(() => build.exited)) !== 0)
      throw new Error("Native launcher build failed");
    yield* Effect.promise(() =>
      copyFile("target/release/pihole-launcher.exe", "bin/pihole-export.exe"),
    );
  }
  yield* Console.log(`Built ${result.outputs[0]?.path ?? outfile}`);
});

Effect.runPromise(build).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
