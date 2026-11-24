# Rust migration

## Boundaries and distribution

- `crates/pihole-core`: supported Pi-hole HTTP API, Serde models, timezone validation,
  stable cursor pagination, cooperative cancellation, CSV/JSONL/SQLite/Parquet writers.
  SQLite here is an **output format**, never access to the FTL database.
- `crates/pihole-backend`: private newline-delimited JSON transport for the Bun UI.
  Auth material goes over stdin. `export` fetches and writes in the Rust process;
  no export rows cross IPC. `page` supports the existing results workbench.
  The compatibility page writer acknowledges each page before the next is submitted.
- `crates/pihole-desktop`: Rune app linked directly to the core, using upstream
  `rune-kit::Button`, `TextEdit` and native accessibility. Blocking work runs on
  Rune's `Latest` workers, with Tokio cancellation and owned-session cleanup.
- `src`: existing CLI/TUI, presets, keyboard controls and display analytics. Those
  UI concerns remain TypeScript; the backend is Rust. No new output mode was added.

Build with `mise run compile`; the TUI embeds its matching Rust backend and needs
no sidecar. Source-mode `mise run dev` builds the backend first; only source mode
uses `PIHOLE_BACKEND_PATH`. Both release workflows publish executable assets directly,
with separate GUI and TUI files per platform (no application archives).

Exports are bounded by one API page (10,000 records), plus per-page conversion/column
buffers. The first cursor is retained and `start` advances by actual row count. CSV
and JSONL keep buffered file handles open, SQLite uses transactions/prepared inserts,
and Parquet writes page-sized row groups. Disk errors happen before query fetching
when the destination cannot be opened. Cancellation retains partial output; a
cancelled Parquet file may lack its footer. Only successful completion returns a count.
A year-long request is possible, but availability depends on Pi-hole retention; no
such request is used in validation. Available-history timestamps are API metadata,
not a promise that a full year is present.

## Dependency updates

All direct JS dependencies were refreshed and both `bun.lock` and `Cargo.lock` are
committed. Rust dependencies resolve to current compatible releases, including
reqwest 0.13, rusqlite 0.43, parquet 60 and Tokio 1.54. Build tool series are selected in
`mise.toml`; VS Code rust-analyzer runs Clippy.

- Effect 4: `Schema.decodeUnknownEffect`, `Schema.Literals`, decoding defaults,
  `Effect.catch`, `Fiber.interrupt`, array-based `Stream.paginate`/collection and
  `effect/http` / `effect.FileSystem` replace the v3/platform APIs. See the
  [official v4 docs](https://effect.website/docs/v4/) and installed package types.
- OpenTUI core/solid 0.9.9, Bun 1.4.5, TypeScript 7, oxfmt 0.80 and oxlint 1.95.
  **Solid is pinned to 1.9.16**, the latest compatible 1.x release: OpenTUI 0.9.9
  declares `solid-js ^1.9.12` and its renderer imports `onMount` and the 1.x store
  APIs. Testing Solid 2.0.3 failed before UI startup. The
  [official Solid migration guide](https://docs.solidjs.com/migration/from-solid-1/)
  requires upgrading runtime, renderer and JSX integration together. An upstream
  Solid 2-compatible OpenTUI release is required before that major upgrade.
- OpenTUI compiled Linux binaries now define `OPENTUI_LIBC` at build time (glibc
  by default), as required by the [official standalone build guide](https://opentui.com/docs/reference/standalone-executables/). This avoids trying to resolve an uninstalled musl package.
- Removed `@effect/platform`, unused `@tuiparts/solid`, `hyparquet-writer` (Rust
  replaces it), and Lefthook. `hyparquet` remains only as an independent test reader.
- hk 2.14 replaces Lefthook through mise: `mise install`, then `mise run hooks`.
  `hk validate` checks `hk.pkl`; checks do not rewrite source files. Formatting is
  explicit (`cargo fmt --all`, `bun run fmt`). See
  [hk configuration](https://hk.jdx.dev/configuration) and
  [mise integration](https://hk.jdx.dev/mise_integration).

## Rune revision and native prerequisites

Rune and rune-kit use upstream revision
`0b8714f102431f884757786cff344d53ec9bcc53`. All eight upstream consumer patches
(wgpu-hal, naga, winit, sctk-adwaita, parley_engine and three AccessKit crates)
use that **same revision** in the root Cargo manifest. No invented plugins or
unpublished local framework edits are required. When upgrading Rune, review its
[root Cargo.toml](https://github.com/anomalyco/rune/blob/0b8714f102431f884757786cff344d53ec9bcc53/Cargo.toml)
and apply the matching patches before regenerating the lockfile.

The desktop enables embedded fonts, accessibility and tooling. Audio/SVG/default
framework features are not needed. Follow Rune's
[Linux prerequisites](https://github.com/anomalyco/rune/blob/0b8714f102431f884757786cff344d53ec9bcc53/crates/rune/README.md#linux)
for native link libraries (xkbcommon and wayland-client) and a Vulkan driver. macOS
and Windows use their native frameworks. Core/CLI builds do not need a GPU or those
Linux desktop development libraries. The default workspace members exclude desktop
so DNS-server builds remain independent of native UI dependencies.

## Reproducible validation (synthetic only)

```sh
mise install
bun install --frozen-lockfile
hk validate
mise run check
mise run test
mise run compile
mise run desktop-check
cargo build -p pihole-desktop --locked
```

Tests cover null/numeric/Unicode fields in four formats, empty output, multiple
pages, fractional and timezone/DST boundaries, all filters, password/TOTP and
borrowed-session ownership, no-auth, API/decode/network/write errors, redirects,
cancellation with no late writes, and worker termination with stdin still open.
The CLI integration uses three synthetic rows; pagination uses 10,005 generated
records within one day to cross the API's fixed cap. PTY validation uses one row
and a three-day confirmation fixture; see the README command.

Desktop tests exercise the actual Rune runtime accessibility tree, password masking,
a checked-in semantic tree snapshot, heavy-query gating and the actual native worker
query/export lifecycle against a one-row loopback HTTP fixture. To deliberately update
the snapshot, run `UPDATE_SNAPSHOTS=1 cargo test -p pihole-desktop` and review the diff.

In this Linux workspace, the desktop compiled using existing runtime libraries via
workspace-local linker aliases (no system install). The graphical smoke failed with
`No suitable graphics adapter found`; there is no display server or Vulkan adapter.
CI now runs the following as **separate steps** on macOS: a GPU-rendered snapshot
and an actual native-window smoke with a wall-clock submission trace. Both passed in
run 45420867602; the startup image was visually inspected. This is startup graphics
validation, separate from the synthetic worker query/export tests and the terminal
PTY test. The commands remain available for local reproduction:

```sh
cargo run -p pihole-desktop -- --snap /tmp/pihole.png --tree /tmp/pihole-tree.json --settle
cargo run -p pihole-desktop -- --native --trace /tmp/pihole-native.jsonl --frames 60
```

These idle startup commands make no HTTP requests. For an interactive export, point
only at a local synthetic fixture API, enter a one-day interval, choose a temporary
absolute destination, click Export to file, verify the file, and repeat with a delayed
fixture response and Cancel. Do not use production credentials or DNS history for
validation. CI tests the core/CLI on Linux/macOS/Windows and Rune on macOS without
installing system packages. No merge, deployment or production export is part of
this change.

## Cross-platform checkout and fixture fixes

Windows CI initially failed formatting after a CRLF checkout. Before changing it,
`core.autocrlf=true` reproduced `i/lf w/crlf` from `git ls-files --eol -- src test`
and the same 30 oxfmt failures. `.gitattributes` now enforces LF; the same fresh
checkout and the real Windows runner report `i/lf w/lf` and pass formatting.
The matrix uses `fail-fast: false` so every platform completes independently.

The network-error test uses a loopback TCP fixture that closes three accepted
connections without HTTP responses. This verifies the actual retry/error path
without assuming that every OS refuses connections to port 1 within five seconds.
No production timeout or retry policy was relaxed to make the test pass.


## Toolchain series and release packaging

`mise.toml` is the only toolchain selector: Rust `1.100` (including rustfmt,
Clippy and rust-analyzer), Bun `1.4`. No `rust-toolchain.toml` overrides mise.
The workspace and all crates declare Rust 1.100 as their minimum supported version.
Use `mise install` on a fresh checkout and `mise upgrade rust bun` for existing
installs to resolve newer patches within those series, never Rust 1.101 or Bun 1.5.
Run commands inside `mise exec -- ...` or an activated mise shell. CI prints
`mise latest rust@1.100`, `mise latest bun@1.4` and checks the actual executable versions.

Reviewed the [Rust 1.100 stable release notes](https://doc.rust-lang.org/releases.html#version-11000-2026-11-12).
Custom allocators and the never type do not simplify this HTTP/export core; no
unnecessary allocator abstractions or nightly features are introduced.

Dev, stable and PR builds share `packages.yml`, so the same packaging and standalone
artifact checks gate each channel. Linux GUI bundles its non-glibc window libraries
(including dynamically loaded Winit libraries) with their distribution copyright
notices. The OS still supplies glibc, display services and GPU drivers. Windows Rust
binaries link the CRT statically; macOS uses system frameworks. Both GUI and TUI are
separate native executable assets. Linux GUI embeds its runtime payload in a native
launcher, extracting into a mode-0700 private temporary directory. The compiled TUI
extracts embedded backend bytes into a private temporary directory, with exclusive
creation and mode 0700 on Unix. Both clean up on normal exit. No Bun/Rust installation is required to run them.

## Observable progress, input and measured work

The direct export dialog shows elapsed time, `Export in progress. Please don’t cancel.`,
and backend events for waiting on the API, writing a received page, and finalizing.
The count includes rows processed by the writer, not a guessed server total or percent.
No progress requests are sent to Pi-hole. Cancellation remains available. A CSV header
can exist while the first response is pending; file size alone does not prove a stall.
Timeouts and errors end the operation with the actual error message.

The synthetic benchmark (`scripts/benchmark.py`, run through mise with
`PIHOLE_BACKEND_PATH` pointing to the release backend) uses 20,000 generated rows in
one day and five full-operation runs. On this Linux workspace, median complete query
fell from 768 ms to 543 ms, and complete JSONL export from 230 ms to 111 ms.
Both versions made exactly two requests, transferred 5,029,184 response bytes and had
peak concurrency one. Query connections fell from two to one; export already reused
one. Every export wrote all 20,000 rows / 6,108,890 bytes. These are local fixture
measurements, not predictions for a production Pi-hole or disk. The changes eliminate
intermediate JSON trees on successful HTTP responses, per-row JSONL key/value clones,
and per-page subprocess/client creation for a complete interactive query. Disk export
remains sequential with writer backpressure and page-bounded memory.

Date fields clear once when focus enters, by keyboard or pointer. Date-only values
(`DD/MM/YYYY` or ISO `YYYY-MM-DD`) mean midnight in the selected IANA zone. Explicit
times keep their prior meaning; nonexistent/ambiguous local times and invalid dates
remain errors. From stays inclusive, until exclusive, without those words in labels.

Secret fields accept deliberate Ctrl+V, with native Cmd+V on macOS. OpenTUI uses its
host clipboard API only on that key; bracketed terminal paste cancels a pending host
read. Rune uses its native secure TextEdit clipboard route. Clipboard data is never
logged or saved. Tests use synthetic strings only.

Rune follows system theme each view and uses the supported Linux D-Bus portal feature
for live appearance and reduced-motion updates. Windows/macOS use Rune's native
preference sources. Missing portal signals use Rune's fallback (dark appearance when
unknown), without polling the network. Status/confirmation feedback uses short opacity
springs; reduced motion switches these off. Fields and focus do not slide or wait for
animations. This app has one workbench, not separate routes. Theme/motion combinations
are simulated in runtime tests; OS preference changes are not claimed as manually
verified on all three desktops.

Dev publication serializes only the publish job and skips a build whose SHA is no
longer main immediately before publishing. Titles show commit UTC time, version and
short SHA. Existing tags/releases/links are preserved; historical GitHub UI ordering
is not rewritten by changing titles.

The release API records dev-e5106e9 at commit 15:00:59 / published 15:03:00 UTC,
and dev-0e2c7b3 at commit 15:16:44 / published 15:22:52 UTC on 2026-11-24. The
public Releases page nevertheless showed the former first when checked. This is
not evidence of an older run finishing later. The antirace guard prevents that
future failure mode; it cannot promise control of GitHub's historical display order.

FTL v6.9 [`queries.c`](https://github.com/pi-hole/FTL/blob/v6.9/src/api/queries.c#L986-L1016)
continues counting filtered results after filling a page. Its cursor caps an ID;
it is not keyset pagination. Increasing offsets can repeat server work. The local
benchmark does not run FTL and cannot establish that server-side cost or diagnose
a real installation. Sequential time windows remain an unvalidated hypothesis,
not a new default; no unlimited page or concurrent prefetch is introduced.
