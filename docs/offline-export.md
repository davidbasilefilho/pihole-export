# Offline snapshot export (Linux)

The annual-history path reads an **already completed, self-contained local SQLite
backup on a different machine with independent CPU, memory and storage**. It does
not create, copy or download that backup. Never run it on the DNS host, against its
live database, via UNC/NFS/SMB, or in a VM/container that competes with production
for resources. Do not change retention to use this command. Disable network access
for the export environment as an additional operational boundary.

`--isolated-backup` is the operator's explicit confirmation of these conditions;
it is not automatic proof of physical isolation. Mount inspection cannot identify
shared SAN/block devices or the physical backing of a container. If independent
storage/compute or a trustworthy existing backup is unavailable, **stop**. No
software can promise absolute DNS availability; this workflow avoids depending on
production DNS or scheduling any production work when those conditions hold.

The first supported platform is Linux. macOS/Windows fail closed before opening
the input: their local-volume checks are not implemented. This is a CLI/core
feature; the current GUI/TUI forms remain API clients and retain the 48-hour gate.
That gate is temporary incident containment, **not** fulfillment of the annual goal.

## Inputs and coverage

Provide absolute local paths without symlinks. The worker checks each path against
Linux mount information before inspecting it, including output, local logs, working directory and SQLite temporary paths.
The compiled offline CLI extracts its embedded worker only under checked local
`/tmp`, ignoring TMPDIR for extraction.
Known network/automount/unknown filesystem types, UNC/URL syntax and `/etc/pihole`
are rejected. Ext2/3/4, XFS, Btrfs, ZFS, tmpfs and overlay are accepted only under
the operator's isolation confirmation. The runtime's temporary directory and the
executable must also be on independent local storage; do not use a network HOME or
TMPDIR. Keep the input directory private and unchanged during the operation.

An input with a `-wal`, `-shm` or `-journal` sidecar is refused. A raw copy of a
running WAL database is not an acceptable backup. The program opens the snapshot
read-only with `immutable=1` (no locking or sidecar creation), uses a read transaction, checks SQLite
integrity and references, and verifies its SHA-256 before processing and again
before publishing output. It never issues backup or attach commands.

The snapshot cannot establish continuous historical coverage by itself. The first
and last recorded queries do not prove that retention/deletion gaps are absent,
and FTL's `ftl` timestamps are not a completeness certificate. Supply coverage
metadata from the operator's **existing backup/retention records**, tied to the
snapshot SHA-256. Do not manufacture coverage from MIN/MAX, the requested dates,
or the file modification time. Unknown completeness means refusal, not an export
labelled complete. The JSON is an attestation, not a cryptographic signature of
its author's assertions.

Example metadata shape (the hash is deliberately a placeholder):

```json
{
  "version": 1,
  "sha256": "REPLACE_WITH_VERIFIED_LOCAL_SNAPSHOT_SHA256",
  "from": 1788220800,
  "until": 1788480000,
  "consistent_backup": true,
  "complete_history": true,
  "api_policy": {
    "privacy_level": 0,
    "exclude_domains": [],
    "exclude_clients": []
  }
}
```

Coverage is an epoch-seconds interval `[from, until)`. The requested interval must
fit entirely inside it; the command never silently clips to available rows. The
result reports both declared coverage and observed timestamp extrema separately.
An empty filtered result within attested coverage is a successful zero-row export.
A period outside coverage fails before creating an output. Missing/invalid
metadata, checksum mismatch or unknown API policy also fail closed.

## API policy and schema compatibility

The backup does **not** contain the HTTP endpoint's runtime privacy/exclusion
configuration. `api_policy` must be attested for that snapshot: currently only
privacy level 0 with **no** `webserver.api.excludeDomains` or `excludeClients`
entries is supported. Any exclusion entry (including an empty expression), other
privacy level or missing policy is rejected. Do not clear this metadata just to
bypass a refusal: otherwise offline output could expose rows the API hides.
Reproducing POSIX regular-expression policy is deliberately not approximated with
a different regex engine. Historical redactions/deletions cannot be recovered.

Supported normalized schemas are **21 and 22**, identified by `ftl.id=0`, with
`query_storage`, `domain_by_id`, `client_by_id`, `forward_by_id` and `addinfo_by_id`.
Unknown versions, legacy inline domain/client values, missing references, malformed
numbers/enums and unsupported layouts are rejected instead of silently dropping
rows. The reader queries reference tables directly, not the `queries` view: client
names come from `client_by_id.name`, CNAME content from `addinfo_by_id` for CNAME
blocked statuses, and list IDs from `query_storage.list_id`. EDE labels and numeric
query types follow FTL v6.9. Backup client names may differ from subsequently
updated live names; there is no resolver call to refresh them.

Filters preserve the supported API semantics: exact string matching unless `*`
requests SQLite LIKE, client IP/name, domain, upstream including `blocklist`,
`cache`, `permitted`, and type/status/reply/DNSSEC enums. SQL parameters carry all
filter values. No runtime API regex exclusions, DataTables search/order, cursor
or online authentication is accepted. Order is query ID descending. Date-only
inputs mean midnight in the selected IANA zone; `from` is inclusive and `until`
exclusive. Explicit times and invalid/ambiguous/nonexistent DST validation reuse
the core parser. Stored numeric timestamp/reply precision and all sixteen output
columns use the same CSV/JSONL/SQLite/Parquet writers as online export; `time_iso`
retains the existing millisecond display convention.

```sh
# On the separate export machine, using an already available local backup:
./pihole-export --offline /srv/offline/snapshot.db \
  --coverage /srv/offline/coverage.json --isolated-backup \
  --from '2026-09-01' --until '2026-09-04' --timezone UTC \
  --client-ip '192.0.2.1' --format parquet \
  --output /srv/exports/history.parquet
```

The command takes no host, URL, password or session option and reads no credential
environment variables. It selects the offline worker before constructing an API
client. There is no network fallback, retry or DNS lookup. The example is only
three days; no annual benchmark has been run. A longer range is accepted offline
only when the independently attested backup covers it.

## Streaming, errors and measurement

A single reverse rowid scan joins references by primary key. No OFFSET pagination,
COUNT-per-page, prefetch, concurrent requests or global result vector is used.
The worker rejects plans requiring a temporary sort. SQLite cache is 2 MiB,
mmap disabled, row length capped at 64 KiB, and CSV/JSONL/SQLite batches stop at 1024 rows or roughly 1 MiB of decoded fields.
Parquet batches stop at 65,536 rows or roughly 16 MiB, with column statistics
omitted and a hard limit of 4096 row groups to bound accumulated footer metadata.
Exceeding that limit fails without publishing a truncated result; use CSV, JSONL
or SQLite for larger histories. It is not a promise that every year's volume fits
one Parquet file. These bound working data, not total runtime RSS. Integrity,
reference and checksum validation require extra sequential local reads; their time
is included in total operation duration. Small selective exports may still scan
the local snapshot; this trades local work for predictable memory and ID order.

Output stays in a sibling `.partial` file until successful finalization and atomic
rename. Errors/cancellation preserve any previous destination. Partial files are
never resumed automatically. Ctrl+C/termination requests cancellation; hard process
or machine failure can leave a partial file. Input errors never trigger online
recovery. Persistent allowlisted diagnostics include `offline_export`, outcomes,
rows/batches, write/finalization duration and local read time, without input/output
paths, filters, host/IP, hash, credentials or DNS rows. JSON stdout contains the
result, declared/observed coverage and local metrics; progress stays in the backend
protocol for future UI consumers.

`test/offline_export.py` creates only short synthetic fixtures, copies the compiled
standalone TUI/CLI executable into a clean directory and validates all four
formats, zero results, refusal paths, logs and snapshot immutability. Its
100,000-row case sends SIGINT through the actual CLI after observing a written
partial batch, then checks the cancelled log and unchanged prior destination. `--trace`
adds strace with socket creation denied and rejects attempted Internet socket,
connect calls; send/receive is allowed only on annotated anonymous Unix IPC
socketpair descriptors used by Bun for the backend stdin/stdout. Local ptrace is blocked in this workspace, so that test
must pass on Linux CI before calling absence-of-network behavior verified at the
syscall level. The CLI test without strace passed locally. Performance results must
include validation and finalization, and are not a forecast of annual duration or
FTL CPU/DNS latency. Filesystem block counts can be zero with cached/tmpfs data;
they are not disk throughput measurements.

## Verified sources

- [FTL v6.9 table definitions](https://github.com/pi-hole/FTL/blob/v6.9/src/database/query-table.h)
- [FTL schema migrations and view](https://github.com/pi-hole/FTL/blob/v6.9/src/database/query-table.c)
- [FTL API queries, filters and exclusions](https://github.com/pi-hole/FTL/blob/v6.9/src/api/queries.c)
- [FTL enum mappings](https://github.com/pi-hole/FTL/blob/v6.9/src/datastructure.c)
- [FTL EDE labels](https://github.com/pi-hole/FTL/blob/v6.9/src/dnsmasq/cache.c)
- [SQLite immutable read-only contract](https://sqlite.org/uri.html#uriimmutable)
- [SQLite snapshot consistency](https://sqlite.org/backup.html)
- [SQLite CROSS JOIN ordering](https://sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join)

Local measurements on the compiled standalone asset (one sample per size/format,
including extraction/startup, integrity/hash checks and atomic finalization):

| Synthetic rows | CSV | JSONL | SQLite | Parquet | Maximum process RSS |
|---|---:|---:|---:|---:|---:|
| 20,000 | 118 ms | 98 ms | 118 ms | 164 ms | about 92 MiB |
| 100,000 | 296 ms | 287 ms | 400 ms | 683 ms | about 92 MiB |

The timestamps span at most 3.5 hours; the requested/attested fixture interval is
three days. These are single local samples, not statistically established speed
or annual estimates. RSS is `wait4.ru_maxrss` (maximum process, not the sum of
concurrent processes); output verification also streams to avoid contaminating
that measurement with large parent-process allocations. Both block I/O counters
were zero in the cached/tmpfs workspace. Logical output sizes and core timings are
in [the machine-readable measurements](offline-benchmark.json). Physical-disk
performance and production FTL/DNS load were not measured.
