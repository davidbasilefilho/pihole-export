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
Release archives must be extracted together: keep `pihole-export` and `pihole-backend`
in the same directory. `PIHOLE_BACKEND_PATH` can select an explicit backend path.

The native Rune app links the same crate directly:

```sh
mise run desktop
```

It provides all query filters, password/TOTP/session/no-auth modes, a 100-row paginated
preview, the available-history timestamps reported by the API, direct export in all
four formats, the heavy-query confirmation and cancellation. Its destination is a
path on the machine running the app. Run the CLI/TUI on the DNS server with an absolute
`--output` path to write on that server. Desktop credentials remain only in process
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

## Long exports on the Pi-hole server

Run the exporter on the DNS server and point it at its local Pi-hole HTTP API.
Use the existing `--output` option with an absolute path on that server's disk.
For example (adjust the dates, API port, and existing destination directory):

```sh
pihole-export --headless --host 127.0.0.1 --auth password \
  --from '2026-08-01 00:00:00' --until '2026-08-02 00:00:00' \
  --timezone UTC --disk --format jsonl --output /mnt/archive/pihole/queries.jsonl
```

Supply `PIHOLE_PASSWORD` in the process environment. This still uses the supported
Pi-hole v6 API over loopback; it does not open the FTL database or copy an export
from a remote machine. Use a local filesystem destination to keep both ends on
this server. The destination directory must already exist and be writable.
Relative paths are resolved from the exporter's working directory.

In the TUI, choose **EXPORT TO FILE** directly on the filters screen, confirm a
heavy query when prompted, then select the format and destination. This streams
the matching pages without fetching the full result table first. **FETCH QUERIES**
still loads the complete result table for interactive analysis. Exporting from
that table re-queries all matching rows, independent of local search and sort.

Larger date ranges, including a year, are accepted, but only retained Pi-hole
history can be exported. `--disk` requests on-disk history; it does not choose the
output path or guarantee a year of retention. The CLI currently reports a row
count, not the available retention interval. Headless runs do not prompt for the
TUI's heavy-query confirmation, so choose the interval deliberately.

Exports write directly to the destination: CSV/JSONL replace its contents and
SQLite replaces its `queries` table. There is no resume checkpoint or atomic
publication; an error or cancellation can leave a partial output (Parquet may
lack its footer). Use a new filename for each run and check the exit status.

## Historical-query safety

On-disk mode is slower and is normally needed beyond Pi-hole's in-memory history. The app asks for explicit confirmation only when the requested range exceeds 48 hours and date/time is the sole query filter:

> This query scans more than 2 days of history without any additional filter and may cause heavy disk I/O. Continue?

Adding a domain, client IP/name, upstream, type, status, reply, or DNSSEC filter suppresses that warning.

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

This Linux/macOS smoke test starts its own HTTP fixture on `127.0.0.1` with one
synthetic row. It checks direct export without a preliminary query, the heavy-query
confirmation, a destination with spaces, CSV readback, cancellation before writing,
and cancellation of an in-flight request. It uses a three-day interval and a temporary
directory that is removed afterward. It never connects to a real Pi-hole. The
optional first argument is the path to the compiled exporter binary.

## Security

Passwords, TOTP values, and session IDs are never written to configuration, logs, or exports. Network failures deliberately omit request details so credentials cannot leak through error rendering. CSV files can contain sensitive DNS history; protect their destination and delete them when no longer needed.

## Upstream compatibility

Pi-hole serves version-matched API documentation at `http://pi.hole/api/docs`. This project follows the current Pi-hole FTL OpenAPI/source behavior and decodes query/auth payloads in Rust with Serde; UI forms and presets use Effect Schema. OpenTUI and Solid are pinned to their required compatible versions; update them together.

## License

Apache License 2.0. See [LICENSE](LICENSE).
