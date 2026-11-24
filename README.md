# Pi-hole Export

A responsive keyboard-and-mouse terminal workbench for querying and exporting complete Pi-hole v6 query logs through the supported HTTP API.

![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

## Features

- Authenticates on every launch with an admin/application password, TOTP, an existing session ID, or Pi-hole's no-password mode.
- Uses only Pi-hole v6 `/api/auth`, `/api/queries/suggestions`, and `/api/queries` HTTP endpoints.
- Combines date/time, on-disk, domain, client IP/name, upstream, type, status, reply, and DNSSEC filters.
- Supports manual values and Pi-hole suggestions; `*` wildcards pass through to Pi-hole.
- Converts human local times in an explicit IANA timezone to exact Unix timestamps. Pi-hole's `from` boundary is inclusive and `until` is exclusive.
- Preserves Pi-hole's first-page cursor and advances `start` in 10,000-row pages, so results and exports are never silently truncated.
- Streams every matching row to CSV, JSONL, SQLite, or Parquet without retaining the complete export dataset.
- Supports aggregate analytics, local search/sort, and filter refinement from selected rows.
- Saves named query presets containing filters only; authentication material is never included.
- Provides `--headless` automation on the same query and export primitives used by the TUI.
- Keeps credentials only in memory, clears form copies after login, never persists them, and closes sessions created by this app on exit.

## Downloads

[Releases](https://github.com/davidbasilefilho/pihole-export/releases) provide six
standalone executable assets: `pihole-export-tui-v0.2.0-<platform>` and
`pihole-export-gui-v0.2.0-<platform>`, for `linux-x64`, `darwin-arm64`, and
`windows-x64` (Windows files end in `.exe`). Dev names also include the commit SHA.
Download just the interface you want; on Linux/macOS run `chmod +x <download>`.
GitHub's automatic source-code archives are not the application downloads.

- **TUI/headless:** the Rust backend is embedded. No sidecar download, Bun or Rust
  installation is required. `--headless` and `--output` work as in source mode.
- **GUI:** the native Rune desktop links the core directly. Linux also embeds the
  required window-library payload; fonts are embedded on every platform.
- Linux targets Ubuntu 24.04-compatible glibc; GUI requires an X11/Wayland desktop
  and a working Vulkan driver supplied by the OS. macOS uses system frameworks;
  Windows uses system graphics. These are unsigned developer executables, not
  signed/notarized installers.

The TUI backend and Linux GUI payload are extracted into a fresh private temporary
folder and cleaned up on normal exit. The temporary filesystem must allow execution;
set `TMPDIR` to a suitable private location if the default is mounted `noexec`.
Abrupt termination can leave temporary files. The compiled TUI always uses its own
embedded backend, ignoring source-mode backend overrides.

CI runs each downloaded-style file in a clean directory, exports one synthetic row
through headless TUI in all four formats, and starts GUI for a graphical snapshot
and a native-window smoke. This is not a full GUI export interaction test.

## Requirements

- Pi-hole v6 with HTTP API access
- [mise](https://mise.jdx.dev/) for the pinned Bun, Rust (rustfmt, Clippy, rust-analyzer) and hk tools; no system-wide tool installation is needed.
- A C linker for bundled SQLite. Desktop builds additionally need the native libraries described in [the migration notes](docs/rust-migration.md).
- A true-color terminal

## Run

```sh
mise install
bun install --frozen-lockfile
mise run hooks
mise run dev
```

Enter an IP/domain such as `10.200.0.242`, or a full URL such as `https://pi.hole`. Use HTTPS whenever the terminal is not on the trusted Pi-hole network.

## Rust core and native desktop

`pihole-core` owns HTTP authentication, query decoding, timestamp conversion, pagination,
cancellation and all four file writers. The existing Bun CLI/TUI calls the sibling
`pihole-backend` process through stdin/stdout; secrets are never command arguments.
Compiled TUI executables embed their matching backend. In source mode only,
`PIHOLE_BACKEND_PATH` can select an explicit backend path.

The native Rune app links the same crate directly:

```sh
mise run desktop
```

It provides all query filters, password/TOTP/session/no-auth modes, a 100-row paginated
preview, the available-history timestamps reported by the API, direct export in all
four formats, range validation and cancellation. Its destination is a
path on the machine running the app; `--output` likewise selects a local destination
for the CLI/TUI. For long or annual exports, use the isolated offline CLI workflow
below, not the production DNS host. Desktop credentials remain only in process
memory and are not saved; each job logs out only sessions it created.

See [architecture, dependency migrations and validation](docs/rust-migration.md).

## Controls

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move through forms |
| `Ctrl+Space` | Open suggestions for the focused filter |
| `↑` / `↓`, `j` / `k` | Navigate rows or suggestions |
| `Enter` | Submit, inspect, or confirm |
| `f` | Edit active filters |
| `r` | Rerun the active query |
| `e` | Export all matching rows |
| `?` | Help |
| `Esc` | Back or cancel active work |
| `q` | Quit from results |

Normal typing is not intercepted while an input is focused.

Every form field, option, row, action, and dialog is also mouse-accessible. Clicking an input moves the same focus state used by Tab traversal, and mouse-wheel scrolling mirrors keyboard list navigation.

## Headless automation

```sh
PIHOLE_PASSWORD='...' pihole-export --headless --host pi.hole \
  --from '2026-08-31 00:00:00' --until '2026-09-01 00:00:00' \
  --timezone UTC --format jsonl --output queries.jsonl
```

Use `PIHOLE_PASSWORD`, `PIHOLE_TOTP`, or `PIHOLE_SESSION_ID` for authentication. Secret command-line flags are deliberately rejected so credentials are not exposed in shell history or process listings.

## Long or annual exports: isolated offline backup

Use **Offline snapshot** (Linux/Windows CLI, TUI or GUI) on a separate machine with independent CPU,
memory and storage. It reads an already-materialized, consistent local FTL SQLite
snapshot without API calls, DNS lookups, backup creation or online fallback. Do not
run it on the production DNS host, open a live database, or use shared production
storage (including UNC/NFS/SMB or a competing VM/container).

In the TUI, choose **Offline snapshot (Ctrl+O)** before connecting; in the GUI, switch
the mode button to **Offline snapshot (no API/DNS)**. Windows uses absolute local
drive paths and needs no WSL. The original v0.2.0 stable build has only the Linux CLI
path; Windows/UI support requires a build containing this change.

Read the [offline prerequisites, coverage and policy requirements](docs/offline-export.md)
before exporting. A trustworthy existing backup must cover the entire requested
period, with independently attested coverage and supported API privacy-policy
metadata. Unknown coverage or incompatible exclusion rules are rejected; stop if
these prerequisites or operational isolation cannot be established.

On the separate Linux export machine, using existing local files and a writable
destination directory (this example requests only three days):

```sh
./pihole-export --offline /srv/offline/snapshot.db \
  --coverage /srv/offline/coverage.json --isolated-backup \
  --from '2026-09-01' --until '2026-09-04' --timezone UTC \
  --format jsonl --output /srv/exports/history.jsonl
```

`--isolated-backup` confirms the operator has established isolation; it does not
prove physical separation automatically. Longer offline periods require matching
backup coverage. Only short synthetic fixtures have been tested: offline progress,
throughput and completion have **not been validated for a real year**. Measurements
are not annual-duration estimates or a guarantee of DNS availability. Offline
progress events currently remain in the backend protocol; the CLI emits its final
JSON result, and the GUI/TUI forms remain API clients. See the linked guide for
supported schemas, formats, memory bounds and limitations.

## Short API exports

For a short API request from a separate client machine, use the supported Pi-hole
HTTP API and write to that client's local disk. This still places query load on
Pi-hole; running the client elsewhere does not make the server-side scan safe.
The **48-hour ceiling is temporary containment, not a safety guarantee**, even for
shorter or filtered requests. It is not the annual-export solution. Do not run long
jobs on production DNS or retry the reported months-long API workload.

For example (adjust the host, dates and existing destination directory):

```sh
pihole-export --headless --host pi.hole --auth password \
  --from '2026-08-01 00:00:00' --until '2026-08-02 00:00:00' \
  --timezone UTC --disk --format jsonl --output /srv/exports/queries.jsonl
```

Supply `PIHOLE_PASSWORD` in the process environment. This uses the supported API;
it does not open the FTL database. The destination directory must already exist
and be writable on the client machine. Relative paths are resolved from the
exporter's working directory.

In the TUI, choose **EXPORT TO FILE** directly on the filters screen, confirm a
range validation, then select the format and destination. This streams
the matching pages without fetching the full result table first. **FETCH QUERIES**
still loads the complete result table for interactive analysis. Exporting from
that table re-queries all matching rows, independent of local search and sort.

Intervals longer than 48 hours are temporarily blocked in the shared core, including filtered requests and `--allow-heavy`. No API query is sent for those ranges. A reported DNS outage is under investigation; causality is not established, and sequential pagination alone does not bound FTL CPU or DNS latency. The 48-hour ceiling is precautionary, not a proven safe workload. No long-export or DNS-availability guarantee is made. Time-window optimization remains disabled until equivalence and server-load benchmarks on isolated FTL demonstrate a benefit. Only retained history can be exported.

Exports stage data in a separate `.partial` file in the destination directory and publish it by rename only after successful finalization. Failure preserves an existing completed destination.

## Historical-query safety

Ranges above 48 hours are blocked before query execution, even with client/domain filters or `--allow-heavy`. Filters do not prove that a scan is cheap. The cap is precautionary and does not establish safe load for shorter ranges; do not retry the reported months-long workload. Query requests have no automatic retries or prefetch. Isolated FTL CPU/DNS latency measurements are still required before enabling longer ranges.

## Checks

```sh
mise run test
mise run compile
mise run check
```

The suite covers authentication success/failure, runtime schemas, every filter and combinations, timezone/DST conversion, inclusive/exclusive boundaries, 10,005-row pagination, complete export counts, CSV escaping, the heavy-query guard, typed failures/cancellation, and OpenTUI startup rendering.

### Interactive PTY regression

After `mise run compile`, exercise the compiled TUI through a real pseudo-terminal:

```sh
python3 -m venv /tmp/pihole-export-pty-venv
/tmp/pihole-export-pty-venv/bin/pip install pexpect==4.9.0 pyte==0.8.2
/tmp/pihole-export-pty-venv/bin/python test/pty_export.py
```

This Linux/macOS smoke test uses its own loopback HTTP fixture and a one-day synthetic interval. It checks direct export without a preliminary query, password paste, alternate destination, successful/zero-row export, cancellation, first-response timeout, disconnect before and after a 10,000-row page, visible errors and persistent sanitized logs. Existing output is preserved on failure, with partial data separately named. No real Pi-hole is contacted. The optional first argument is the compiled exporter path.

## Security

Passwords, TOTP values, and session IDs are never written to configuration, logs, or exports. Network failures deliberately omit request details so credentials cannot leak through error rendering. CSV files can contain sensitive DNS history; protect their destination and delete them when no longer needed.

## Upstream compatibility

Pi-hole serves version-matched API documentation at `http://pi.hole/api/docs`. This project follows the current Pi-hole FTL OpenAPI/source behavior and decodes query/auth payloads in Rust with Serde; UI forms and presets use Effect Schema. OpenTUI and Solid are pinned to their required compatible versions; update them together.

## License

Apache License 2.0. See [LICENSE](LICENSE).

### Local diagnostics

TUI, GUI and headless CLI share bounded local diagnostics in the Rust core. The export dialog and desktop show the directory:

- Linux: `$XDG_STATE_HOME/pihole-export/logs`, default `~/.local/state/pihole-export/logs`.
- macOS: `~/Library/Logs/pihole-export/logs`.
- Windows: `%LOCALAPPDATA%\pihole-export\logs`.

At most 32 operation files are retained (two small JSON records each, normally well under 128 KiB total). Each contains UTC time, application version, local operation ID, operation/format, total duration, HTTP wait/body time and JSON decode time separately, combined page time, writer/finalization time, completed page/row counts and an allowlisted outcome/cause. A started record without completion means the process ended before it could report completion; it does not establish why. Concurrent processes can transiently exceed the retention count. There is no telemetry or extra server request. Logging failures never fail the export and never write to CLI stdout.

No credentials, session IDs, tokens, URLs, hosts, IPs, filters, DNS records or output paths are logged. Server error text is never copied into diagnostics. `zero_results` is a successfully completed empty export; `error` or `cancelled` can leave a separately named `.partial` file (including a CSV with only its header). A header-only file alone does not distinguish those cases. Historical executions cannot be reconstructed from these logs.

Exports now write a uniquely named hidden `.partial` file beside the destination. Only a successfully flushed, synchronized and closed file is renamed to the requested output. Failure/cancellation preserves the previous destination, if any; partial files are never presented under the completed output name. They are retained for explicit inspection/removal and are not resumed automatically. Query transport failures are not automatically retried, including loss of connection after a completed page.
