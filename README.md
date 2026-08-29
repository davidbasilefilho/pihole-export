# Pi-hole Export

A dense, keyboard-first terminal UI for querying and exporting complete Pi-hole v6 query logs through the supported HTTP API.

![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

## Features

- Authenticates on every launch with an admin/application password, TOTP, an existing session ID, or Pi-hole's no-password mode.
- Uses only Pi-hole v6 `/api/auth`, `/api/queries/suggestions`, and `/api/queries` HTTP endpoints.
- Combines date/time, on-disk, domain, client IP/name, upstream, type, status, reply, and DNSSEC filters.
- Supports manual values and Pi-hole suggestions; `*` wildcards pass through to Pi-hole.
- Converts human local times in an explicit IANA timezone to exact Unix timestamps. Pi-hole's `from` boundary is inclusive and `until` is exclusive.
- Preserves Pi-hole's first-page cursor and advances `start` in 10,000-row pages, so results and exports are never silently truncated.
- Exports every matching row as UTF-8 CSV to a local or OS-supported UNC path.
- Keeps credentials only in memory, clears form copies after login, never persists them, and closes sessions created by this app on exit.

## Requirements

- Pi-hole v6 with HTTP API access
- [mise](https://mise.jdx.dev/) (recommended), or Bun 1.4 and Zig 0.16
- A true-color terminal

## Run

```sh
mise install
bun install
mise run dev
```

Enter an IP/domain such as `10.200.0.242`, or a full URL such as `https://pi.hole`. Use HTTPS whenever the terminal is not on the trusted Pi-hole network.

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

## Historical-query safety

On-disk mode is slower and is normally needed beyond Pi-hole's in-memory history. The app asks for explicit confirmation only when the requested range exceeds 48 hours and date/time is the sole query filter:

> This query scans more than 2 days of history without any additional filter and may cause heavy disk I/O. Continue?

Adding a domain, client IP/name, upstream, type, status, reply, or DNSSEC filter suppresses that warning.

## Checks

```sh
mise run test
mise run typecheck
mise run check
```

The suite covers authentication success/failure, runtime schemas, every filter and combinations, timezone/DST conversion, inclusive/exclusive boundaries, 10,005-row pagination, complete export counts, CSV escaping, the heavy-query guard, typed failures/cancellation, and OpenTUI startup rendering.

## Security

Passwords, TOTP values, and session IDs are never written to configuration, logs, or exports. Network failures deliberately omit request details so credentials cannot leak through error rendering. CSV files can contain sensitive DNS history; protect their destination and delete them when no longer needed.

## Upstream compatibility

Pi-hole serves version-matched API documentation at `http://pi.hole/api/docs`. This project follows the current Pi-hole FTL OpenAPI/source behavior and decodes every external payload with Effect Schema. OpenTUI and Solid are pinned to their required compatible versions; update them together.

## License

Apache License 2.0. See [LICENSE](LICENSE).
