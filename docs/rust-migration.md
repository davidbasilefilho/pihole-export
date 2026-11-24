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

Build with `mise run compile`; distribute **both** files in `bin/`. Release workflows
package both executables in one tar.gz, including Windows `.exe` files. Source-mode
`mise run dev` builds the backend first. `PIHOLE_BACKEND_PATH` can override discovery.

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
reqwest 0.13, rusqlite 0.43, parquet 60 and Tokio 1.54. Build tools are pinned in
`mise.toml` and `rust-toolchain.toml`; VS Code rust-analyzer runs Clippy.

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
The following steps remain **manual on a desktop with a working GPU/display**:

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
