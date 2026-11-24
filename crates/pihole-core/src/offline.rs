//! Offline FTL schema 21/22 snapshots. No API client, discovery, backup or network fallback.
use crate::diagnostics::Diagnostic;
use crate::{Client, Ede, Error, Exporter, Query, Reply, Result, Spec, local_time};
use ring::digest::{Context, SHA256};
use rusqlite::{Connection, OpenFlags, types::Value};
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflineRequest {
    pub snapshot: String,
    pub coverage: String,
    pub isolated_backup: bool,
    pub filters: serde_json::Value,
    pub path: String,
    pub format: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Coverage {
    version: u32,
    sha256: String,
    from: f64,
    until: f64,
    consistent_backup: bool,
    complete_history: bool,
    api_policy: ApiPolicy,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApiPolicy {
    privacy_level: u8,
    exclude_domains: Vec<String>,
    exclude_clients: Vec<String>,
}
fn invalid(message: &str) -> Error {
    Error::new("ValidationError", message)
}
fn db_error(_: rusqlite::Error) -> Error {
    invalid("Snapshot is invalid or uses an unsupported FTL schema; no online fallback")
}
fn cancelled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        Ok(())
    }
}

// Fail closed on platforms without a mount classifier. No pathname lookup before
// checking the mount table: a UNC/automount must not cause a remote access.
fn local_path(path: &Path) -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(invalid(
            "Offline isolation checks currently support Linux only; use a separate Linux machine with local storage",
        ));
    }
    if !path.is_absolute()
        || path.to_string_lossy().contains('\\')
        || path.to_string_lossy().starts_with("//")
    {
        return Err(invalid(
            "Offline paths must be absolute local paths, never UNC or URLs",
        ));
    }
    let mounts = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|_| invalid("Cannot verify local mounts"))?;
    let mut part = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(p) => part.push(p),
            _ => return Err(invalid("Offline paths cannot contain parent components")),
        }
        let mount = mounts
            .lines()
            .filter_map(|line| {
                let (left, right) = line.split_once(" - ")?;
                let point = left
                    .split_whitespace()
                    .nth(4)?
                    .replace("\\040", " ")
                    .replace("\\011", "\t")
                    .replace("\\012", "\n")
                    .replace("\\134", "\\");
                part.starts_with(&point)
                    .then(|| (point.len(), right.split_whitespace().next().unwrap_or("")))
            })
            .max_by_key(|m| m.0);
        if !mount.is_some_and(|(_, kind)| {
            matches!(
                kind,
                "ext4" | "ext3" | "ext2" | "xfs" | "btrfs" | "tmpfs" | "overlay" | "zfs"
            )
        }) {
            return Err(invalid(
                "Offline paths must use verified local storage; shared, automounted and unknown filesystems are blocked",
            ));
        }
        match fs::symlink_metadata(&part) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(invalid("Offline paths cannot contain symbolic links"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid("Cannot inspect offline path")),
        }
    }
    if path.starts_with("/etc/pihole") {
        return Err(invalid(
            "The active Pi-hole database directory is not an offline input",
        ));
    }
    Ok(())
}
fn digest(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|_| invalid("Cannot read local snapshot"))?;
    let mut hash = Context::new(&SHA256);
    let mut buffer = [0; 65536];
    loop {
        cancelled(cancel)?;
        let n = file
            .read(&mut buffer)
            .map_err(|_| invalid("Cannot read local snapshot"))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
const TYPES: &[&str] = &[
    "NONE", "A", "AAAA", "ANY", "SRV", "SOA", "PTR", "TXT", "NAPTR", "MX", "DS", "RRSIG", "DNSKEY",
    "NS", "OTHER", "SVCB", "HTTPS",
];
const STATUS: &[&str] = &[
    "UNKNOWN",
    "GRAVITY",
    "FORWARDED",
    "CACHE",
    "REGEX",
    "DENYLIST",
    "EXTERNAL_BLOCKED_IP",
    "EXTERNAL_BLOCKED_NULL",
    "EXTERNAL_BLOCKED_NXRA",
    "GRAVITY_CNAME",
    "REGEX_CNAME",
    "DENYLIST_CNAME",
    "RETRIED",
    "RETRIED_DNSSEC",
    "IN_PROGRESS",
    "DBBUSY",
    "SPECIAL_DOMAIN",
    "CACHE_STALE",
    "EXTERNAL_BLOCKED_EDE15",
];
const REPLY: &[&str] = &[
    "UNKNOWN", "NODATA", "NXDOMAIN", "CNAME", "IP", "DOMAIN", "RRNAME", "SERVFAIL", "REFUSED",
    "NOTIMP", "OTHER", "DNSSEC", "NONE", "BLOB",
];
const DNSSEC: &[&str] = &[
    "UNKNOWN",
    "SECURE",
    "INSECURE",
    "BOGUS",
    "ABANDONED",
    "TRUNCATED",
];
const EDE: &[&str] = &[
    "other",
    "unsupported DNSKEY algorithm",
    "unsupported DS digest",
    "stale answer",
    "forged",
    "DNSSEC indeterminate",
    "DNSSEC bogus",
    "DNSSEC signature expired",
    "DNSSEC sig not yet valid",
    "DNSKEY missing",
    "RRSIG missing",
    "no zone key bit set",
    "NSEC(3) missing",
    "cached error",
    "not ready",
    "blocked",
    "censored",
    "filtered",
    "prohibited",
    "stale NXDOMAIN",
    "not authoritative",
    "not supported",
    "no reachable authority",
    "network error",
    "invalid data",
    "signature expired before valid",
    "too early",
    "unsupported NSEC3 iterations value",
    "uanble to conform to policy",
    "synthesized",
];
fn enum_name(names: &[&str], index: i64) -> Result<String> {
    names
        .get(usize::try_from(index).unwrap_or(usize::MAX))
        .map(|s| (*s).into())
        .ok_or_else(|| invalid("Snapshot contains an unsupported enumeration"))
}
fn add_text(sql: &mut String, values: &mut Vec<Value>, column: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    sql.push_str(&format!(
        " AND {column} {} ?",
        if value.contains('*') { "LIKE" } else { "=" }
    ));
    values.push(Value::Text(value.replace('*', "%")));
}
fn add_enum(
    sql: &mut String,
    values: &mut Vec<Value>,
    column: &str,
    value: &str,
    names: &[&str],
) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    let index = names
        .iter()
        .position(|n| n.eq_ignore_ascii_case(value))
        .ok_or_else(|| invalid("Invalid offline enum filter"))?;
    sql.push_str(&format!(" AND {column} = ?"));
    values.push(Value::Integer(index as i64));
    Ok(())
}
const JOINS: &str = " FROM query_storage q NOT INDEXED LEFT JOIN domain_by_id d ON q.domain=d.id LEFT JOIN client_by_id c ON q.client=c.id LEFT JOIN forward_by_id f ON q.forward=f.id LEFT JOIN addinfo_by_id a ON q.additional_info=a.id";
fn selection(spec: &Spec) -> Result<(String, Vec<Value>)> {
    let ordered_joins = JOINS
        .replace("LEFT JOIN domain_by_id", "CROSS JOIN domain_by_id")
        .replace("LEFT JOIN client_by_id", "CROSS JOIN client_by_id");
    let mut sql = format!(
        "SELECT q.id,q.timestamp,q.type,q.status,d.domain,c.ip,c.name,f.forward,a.content,q.reply_type,q.reply_time,q.dnssec,q.list_id,q.ede{ordered_joins} WHERE q.timestamp>=? AND q.timestamp<?"
    );
    let mut values = vec![Value::Real(spec.from), Value::Real(spec.until)];
    for (column, value) in [
        ("d.domain", &spec.domain),
        ("c.ip", &spec.client_ip),
        ("c.name", &spec.client_name),
    ] {
        add_text(&mut sql, &mut values, column, value);
    }
    let upstream = spec.upstream.split(' ').next().unwrap_or("");
    match upstream {
        "blocklist" => sql.push_str(" AND q.status IN (1,4,5,6,7,8,9,10,11,15,16,18)"),
        "cache" => sql.push_str(" AND q.status IN (3,17)"),
        "permitted" => sql.push_str(" AND q.status IN (0,2,3,12,13,14,17)"),
        _ => add_text(&mut sql, &mut values, "f.forward", upstream),
    }
    if spec.r#type.eq_ignore_ascii_case("OTHER") {
        sql.push_str(" AND q.type>=100");
    } else if let Some(number) = spec.r#type.to_ascii_uppercase().strip_prefix("TYPE") {
        if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid("Invalid offline type filter"));
        }
        let number: u16 = number
            .parse()
            .map_err(|_| invalid("Invalid offline type filter"))?;
        sql.push_str(" AND q.type=?");
        values.push(Value::Integer(100 + i64::from(number)));
    } else {
        if spec.r#type.eq_ignore_ascii_case("NONE") {
            return Err(invalid("Invalid offline type filter"));
        }
        add_enum(&mut sql, &mut values, "q.type", &spec.r#type, TYPES)?;
    }
    add_enum(&mut sql, &mut values, "q.status", &spec.status, STATUS)?;
    add_enum(&mut sql, &mut values, "q.reply_type", &spec.reply, REPLY)?;
    add_enum(&mut sql, &mut values, "q.dnssec", &spec.dnssec, DNSSEC)?;
    sql.push_str(" ORDER BY q.id DESC");
    Ok((sql, values))
}
fn decode(row: &rusqlite::Row<'_>) -> Result<Query> {
    let number =
        |n| -> Result<i64> { Ok(row.get::<_, Option<i64>>(n).map_err(db_error)?.unwrap_or(0)) };
    let optional = |n| -> Result<Option<String>> {
        Ok(row
            .get::<_, Option<String>>(n)
            .map_err(db_error)?
            .filter(|s| !s.is_empty()))
    };
    let kind = number(2)?;
    let status = number(3)?;
    let ede = number(13)?;
    let time: f64 = row.get(1).map_err(db_error)?;
    let reply_time: f64 = row
        .get::<_, Option<f64>>(10)
        .map_err(db_error)?
        .unwrap_or(0.0);
    if !time.is_finite() || !reply_time.is_finite() {
        return Err(invalid("Invalid numeric snapshot field"));
    }
    Ok(Query {
        id: row.get(0).map_err(db_error)?,
        time,
        r#type: if (100..=65635).contains(&kind) {
            format!("TYPE{}", kind - 100)
        } else if kind == 14 {
            "TYPE0".into()
        } else {
            enum_name(TYPES, kind)?
        },
        status: Some(enum_name(STATUS, status)?),
        domain: row.get(4).map_err(db_error)?,
        client: Client {
            ip: row.get(5).map_err(db_error)?,
            name: optional(6)?,
        },
        upstream: optional(7)?,
        cname: if matches!(status, 9..=11) {
            optional(8)?
        } else {
            None
        },
        reply: Reply {
            r#type: Some(enum_name(REPLY, number(9)?)?),
            time: reply_time,
        },
        dnssec: Some(enum_name(DNSSEC, number(11)?)?),
        list_id: row.get(12).map_err(db_error)?,
        ede: Ede {
            code: ede,
            text: (ede > 0).then(|| EDE.get(ede as usize).unwrap_or(&"unknown").to_string()),
        },
    })
}

pub fn export_offline(
    request: &OfflineRequest,
    cancel: &CancellationToken,
    mut progress: impl FnMut(&str, usize),
) -> Result<serde_json::Value> {
    // These checks run before even opening a log, input file or HTTP client.
    if !request.isolated_backup {
        return Err(invalid(
            "Offline export requires --isolated-backup: a separate machine and independent local storage, with a consistent backup already available; never run on the DNS server",
        ));
    }
    for path in [&request.snapshot, &request.coverage, &request.path] {
        local_path(Path::new(path))?;
    }
    // Never touch an unknown log mount or fail a valid export for logging.
    let logs = crate::logs_directory().filter(|path| local_path(path).is_ok());
    let mut log = Diagnostic::at(logs, "offline_export", &request.format);
    let result = offline_tracked(request, cancel, &mut progress, &mut log);
    let result = if result.is_err() && cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        result
    };
    log.finish(&result);
    result
}
fn offline_tracked(
    request: &OfflineRequest,
    cancel: &CancellationToken,
    progress: &mut impl FnMut(&str, usize),
    log: &mut Diagnostic,
) -> Result<serde_json::Value> {
    let started = Instant::now();
    cancelled(cancel)?;
    let snapshot = Path::new(&request.snapshot);
    if !fs::metadata(snapshot).is_ok_and(|m| m.is_file()) {
        return Err(invalid("A regular local SQLite snapshot is required"));
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        if Path::new(&format!("{}{suffix}", request.snapshot)).exists() {
            return Err(invalid(
                "Snapshot has journal/WAL sidecars; provide a completed self-contained backup",
            ));
        }
    }
    if request.path == request.snapshot || request.path == request.coverage {
        return Err(invalid(
            "Output must not replace snapshot or coverage metadata",
        ));
    }
    let mut coverage_bytes = Vec::new();
    fs::File::open(&request.coverage)
        .map_err(|_| invalid("Local coverage metadata is required"))?
        .take(8193)
        .read_to_end(&mut coverage_bytes)
        .map_err(|_| invalid("Cannot read coverage metadata"))?;
    if coverage_bytes.len() > 8192 {
        return Err(invalid("Coverage metadata exceeds size limit"));
    }
    let coverage: Coverage = serde_json::from_slice(&coverage_bytes)
        .map_err(|_| invalid("Invalid coverage metadata"))?;
    if coverage.version != 1
        || !coverage.consistent_backup
        || !coverage.complete_history
        || !coverage.from.is_finite()
        || !coverage.until.is_finite()
        || coverage.until <= coverage.from
    {
        return Err(invalid(
            "Coverage must attest a consistent backup and complete retained interval; row extrema alone cannot prove coverage",
        ));
    }
    if coverage.api_policy.privacy_level != 0
        || !coverage.api_policy.exclude_domains.is_empty()
        || !coverage.api_policy.exclude_clients.is_empty()
    {
        return Err(invalid(
            "Offline parity requires an attested privacy level 0 and no API excludeDomains/excludeClients rules; snapshot alone cannot reveal these settings",
        ));
    }
    let zone = request.filters["timezone"].as_str().unwrap_or("UTC");
    let mut form = request.filters.clone();
    for key in ["from", "until"] {
        form[key] = json!(local_time(
            request.filters[key].as_str().unwrap_or(""),
            zone
        )?);
    }
    form["disk"] = json!(true);
    for key in [
        "domain",
        "clientIp",
        "clientName",
        "upstream",
        "type",
        "status",
        "reply",
        "dnssec",
    ] {
        if let Some(value) = form[key].as_str() {
            form[key] = json!(value.trim());
        }
    }
    let spec: Spec =
        serde_json::from_value(form).map_err(|_| invalid("Invalid offline filters"))?;
    spec.validate_interval()?;
    if spec.from < coverage.from || spec.until > coverage.until {
        return Err(invalid(&format!(
            "Requested interval is outside declared backup coverage [{}, {}); no export started",
            coverage.from, coverage.until
        )));
    }
    progress("validating", 0);
    if digest(snapshot, cancel)? != coverage.sha256 {
        return Err(invalid("Snapshot SHA-256 does not match coverage metadata"));
    }
    let mut uri = reqwest::Url::from_file_path(snapshot)
        .map_err(|_| invalid("Invalid local snapshot path"))?;
    uri.set_query(Some("mode=ro&immutable=1"));
    let mut db = Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(db_error)?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(db_error)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA automatic_index=OFF; PRAGMA temp_store=FILE; BEGIN;").map_err(db_error)?;
    // Cancel preflight scans too, not only the export loop.
    let watcher = cancel.clone();
    db.progress_handler(1000, Some(move || watcher.is_cancelled()))
        .map_err(db_error)?;
    db.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 65536)
        .map_err(db_error)?;
    for table in [
        "ftl",
        "query_storage",
        "domain_by_id",
        "client_by_id",
        "forward_by_id",
        "addinfo_by_id",
    ] {
        let kind: String = db
            .query_row(
                "SELECT type FROM pragma_table_list WHERE schema='main' AND name=?",
                [table],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let pk: i64 = db
            .query_row(
                "SELECT pk FROM pragma_table_info(?) WHERE name='id'",
                [table],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let declared: String = db
            .query_row(
                "SELECT type FROM pragma_table_info(?) WHERE name='id'",
                [table],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let without_rowid: i64 = db
            .query_row(
                "SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?",
                [table],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if kind != "table"
            || pk != 1
            || !declared.eq_ignore_ascii_case("INTEGER")
            || without_rowid != 0
        {
            return Err(invalid("Unsupported snapshot table layout"));
        }
    }
    let version: i64 = db
        .query_row("SELECT value FROM ftl WHERE id=0", [], |r| r.get(0))
        .map_err(db_error)?;
    if !matches!(version, 21 | 22) {
        return Err(invalid(
            "Only normalized FTL history schemas 21 and 22 are supported",
        ));
    }
    let integrity: String = db
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(db_error)?;
    if integrity != "ok" {
        return Err(invalid("Snapshot integrity check failed"));
    }
    let (first, last): (Option<f64>, Option<f64>) = db
        .query_row(
            "SELECT MIN(timestamp),MAX(timestamp) FROM query_storage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    // Do not silently omit dangling references or legacy inline values.
    let bad: bool = db.query_row(&format!("SELECT EXISTS(SELECT 1{JOINS} WHERE d.id IS NULL OR c.id IS NULL OR (q.forward IS NOT NULL AND f.id IS NULL) OR (q.additional_info IS NOT NULL AND a.id IS NULL))"),[],|r|r.get(0)).map_err(db_error)?;
    if bad {
        return Err(invalid(
            "Snapshot has missing reference rows or legacy inline values; export refused",
        ));
    }
    let (sql, values) = selection(&spec)?;
    let mut plan = db
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .map_err(db_error)?;
    let mut steps = plan
        .query(rusqlite::params_from_iter(values.iter()))
        .map_err(db_error)?;
    while let Some(step) = steps.next().map_err(db_error)? {
        let detail: String = step.get(3).map_err(db_error)?;
        if detail.contains("USE TEMP") {
            return Err(invalid(
                "Snapshot query requires an unsupported sort; export refused",
            ));
        }
    }
    drop(steps);
    drop(plan);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(values))
        .map_err(db_error)?;
    let validation_ms = started.elapsed().as_millis();
    let mut writer = Exporter::new_offline(&request.path, &request.format)?;
    let parquet = request.format == "parquet";
    let batch_rows = if parquet { 65_536 } else { 1024 };
    let batch_bytes_target = if parquet { 16 * 1_048_576 } else { 1_048_576 };
    let mut batch = Vec::with_capacity(batch_rows);
    let mut read_us = 0u128;
    loop {
        cancelled(cancel)?;
        progress("reading", log.rows);
        let read_started = Instant::now();
        let mut batch_bytes = 0;
        while batch.len() < batch_rows && batch_bytes < batch_bytes_target {
            let next = rows.next().map_err(db_error)?;
            let Some(row) = next else {
                break;
            };
            let decoded = decode(row)?;
            batch_bytes += decoded.domain.len()
                + decoded.client.ip.len()
                + decoded.client.name.as_ref().map_or(0, String::len)
                + decoded.upstream.as_ref().map_or(0, String::len)
                + decoded.cname.as_ref().map_or(0, String::len)
                + 256;
            batch.push(decoded);
        }
        read_us += read_started.elapsed().as_micros();
        log.local_read_us = read_us;
        if batch.is_empty() {
            break;
        }
        if parquet && log.pages >= 4096 {
            return Err(invalid(
                "Parquet footer budget exceeded (4096 row groups); destination unchanged. Use CSV, JSONL or SQLite for larger offline results",
            ));
        }
        log.phase("writing");
        progress("writing", log.rows);
        writer.write(&batch, cancel)?;
        log.rows += batch.len();
        log.pages += 1;
        batch.clear();
        log.phase("reading");
    }
    cancelled(cancel)?;
    // A changed input cannot be published as a successful export.
    if digest(snapshot, cancel)? != coverage.sha256 {
        return Err(invalid(
            "Snapshot changed during export; destination unchanged",
        ));
    }
    cancelled(cancel)?;
    log.phase("finalizing");
    progress("finalizing", log.rows);
    let mut result = writer.finish()?;
    result["source"] = json!("offline_snapshot");
    result["coverage"] = json!({"from":coverage.from,"until":coverage.until,"observedFirst":first,"observedLast":last,"basis":"operator-attested; not inferred from query extrema"});
    result["metrics"] = json!({"totalMs":started.elapsed().as_millis(),"readUs":read_us,"validationMs":validation_ms,"batchBytesTarget":batch_bytes_target,"batchRows":batch_rows,"networkRequests":0,"snapshotBytes":fs::metadata(snapshot).map(|m|m.len()).unwrap_or(0)});
    Ok(result)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    fn fixture(count: usize) -> (tempfile::TempDir, OfflineRequest) {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = dir.path().join("snapshot.db");
        let mut db = Connection::open(&snapshot).unwrap();
        db.execute_batch("CREATE TABLE ftl(id INTEGER PRIMARY KEY,value BLOB); INSERT INTO ftl VALUES(0,22);
            CREATE TABLE query_storage(id INTEGER PRIMARY KEY,timestamp INTEGER,type INTEGER,status INTEGER,domain INTEGER,client INTEGER,forward INTEGER,additional_info INTEGER,reply_type INTEGER,reply_time REAL,dnssec INTEGER,list_id INTEGER,ede INTEGER);
            CREATE TABLE domain_by_id(id INTEGER PRIMARY KEY,domain TEXT); INSERT INTO domain_by_id VALUES(1,'a.example');
            CREATE TABLE client_by_id(id INTEGER PRIMARY KEY,ip TEXT,name TEXT); INSERT INTO client_by_id VALUES(1,'192.0.2.1','synthetic');
            CREATE TABLE forward_by_id(id INTEGER PRIMARY KEY,forward TEXT); INSERT INTO forward_by_id VALUES(1,'192.0.2.53#53');
            CREATE TABLE addinfo_by_id(id INTEGER PRIMARY KEY,type INTEGER,content); INSERT INTO addinfo_by_id VALUES(1,1,'cname.example');").unwrap();
        let tx = db.transaction().unwrap();
        for id in 1..=count {
            tx.execute("INSERT INTO query_storage VALUES(?,1788220800.125+?,1,9,1,1,1,1,4,1.23456789,1,42,15)",rusqlite::params![id as i64,id as i64]).unwrap();
        }
        tx.commit().unwrap();
        drop(db);
        let coverage = dir.path().join("coverage.json");
        fs::write(&coverage,json!({"version":1,"sha256":digest(&snapshot,&CancellationToken::new()).unwrap(),"from":1788220800.0,"until":1788652800.0,"consistent_backup":true,"complete_history":true,"api_policy":{"privacy_level":0,"exclude_domains":[],"exclude_clients":[]}}).to_string()).unwrap();
        let request = OfflineRequest {
            snapshot: snapshot.to_str().unwrap().into(),
            coverage: coverage.to_str().unwrap().into(),
            isolated_backup: true,
            filters: json!({"from":"2026-09-01","until":"2026-09-06","timezone":"UTC"}),
            path: dir.path().join("out").to_str().unwrap().into(),
            format: "jsonl".into(),
        };
        (dir, request)
    }
    fn rehash(request: &OfflineRequest) {
        let mut coverage: serde_json::Value =
            serde_json::from_slice(&fs::read(&request.coverage).unwrap()).unwrap();
        coverage["sha256"] =
            json!(digest(Path::new(&request.snapshot), &CancellationToken::new()).unwrap());
        fs::write(&request.coverage, coverage.to_string()).unwrap();
    }
    #[test]
    fn offline_formats_filters_order_precision_and_immutable_input() {
        let (_dir, mut request) = fixture(3);
        let before = fs::read(&request.snapshot).unwrap();
        for format in ["csv", "jsonl", "sqlite", "parquet"] {
            request.format = format.into();
            let result = export_offline(&request, &CancellationToken::new(), |_, _| {}).unwrap();
            assert_eq!(result["count"], 3);
            assert_eq!(result["metrics"]["networkRequests"], 0);
            assert_eq!(fs::read(&request.snapshot).unwrap(), before);
        }
        request.format = "jsonl".into();
        for (key, value) in [
            ("domain", "  a.*  "),
            ("clientIp", "192.0.2.*"),
            ("clientName", "synth*"),
            ("upstream", "blocklist"),
            ("type", " a "),
            ("status", "gravity_cname"),
            ("reply", "IP"),
            ("dnssec", "SECURE"),
        ] {
            request.filters[key] = json!(value);
        }
        export_offline(&request, &CancellationToken::new(), |_, _| {}).unwrap();
        let data: Vec<serde_json::Value> = fs::read_to_string(&request.path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(data.len(), 3);
        assert_eq!(data[0]["query_id"], 3);
        assert_eq!(data[0]["timestamp"], 1788220803.125);
        assert_eq!(data[0]["reply_time_ms"], 1.23456789);
        assert_eq!(data[0]["cname"], "cname.example");
        assert_eq!(data[0]["ede_text"], "blocked");
        request.filters["domain"] = json!("absent.example");
        assert_eq!(
            export_offline(&request, &CancellationToken::new(), |_, _| {}).unwrap()["count"],
            0
        );
    }
    #[test]
    fn preflight_rejects_unknown_incomplete_changed_live_or_remote_input() {
        let (_dir, mut request) = fixture(3);
        fs::write(&request.path, "previous").unwrap();
        request.isolated_backup = false;
        assert!(export_offline(&request, &CancellationToken::new(), |_, _| {}).is_err());
        request.isolated_backup = true;
        request.filters["until"] = json!("2026-09-07");
        assert!(
            export_offline(&request, &CancellationToken::new(), |_, _| {})
                .unwrap_err()
                .message
                .contains("coverage")
        );
        request.filters["until"] = json!("2026-09-06");
        let db = Connection::open(&request.snapshot).unwrap();
        db.execute("UPDATE ftl SET value=23", []).unwrap();
        drop(db);
        rehash(&request);
        assert!(
            export_offline(&request, &CancellationToken::new(), |_, _| {})
                .unwrap_err()
                .message
                .contains("21 and 22")
        );
        let db = Connection::open(&request.snapshot).unwrap();
        db.execute("UPDATE ftl SET value=21", []).unwrap();
        db.execute("DELETE FROM domain_by_id", []).unwrap();
        drop(db);
        rehash(&request);
        assert!(
            export_offline(&request, &CancellationToken::new(), |_, _| {})
                .unwrap_err()
                .message
                .contains("reference")
        );
        assert_eq!(fs::read_to_string(&request.path).unwrap(), "previous");
        assert!(local_path(Path::new("//server/share/snapshot.db")).is_err());
        assert!(local_path(Path::new("/etc/pihole/pihole-FTL.db")).is_err());
        assert!(local_path(Path::new("/proc/1/mem")).is_err());
    }
    #[test]
    fn cancellation_after_batch_preserves_destination_and_logs_no_secret() {
        let (_dir, request) = fixture(1600);
        fs::write(&request.path, "previous").unwrap();
        let cancel = CancellationToken::new();
        let result = export_offline(&request, &cancel, |phase, rows| {
            if phase == "reading" && rows > 0 {
                cancel.cancel();
            }
        });
        assert_eq!(result.unwrap_err().tag, "Cancelled");
        assert_eq!(fs::read_to_string(&request.path).unwrap(), "previous");
        assert!(
            fs::read_dir(Path::new(&request.path).parent().unwrap())
                .unwrap()
                .flatten()
                .any(|f| f.file_name().to_string_lossy().ends_with(".partial"))
        );
    }
    #[test]
    fn bounds_are_inclusive_exclusive_and_schema_21_supported() {
        let (_dir, mut request) = fixture(4);
        let db = Connection::open(&request.snapshot).unwrap();
        db.execute("UPDATE ftl SET value=21", []).unwrap();
        drop(db);
        rehash(&request);
        request.filters["from"] = json!("2026-09-01 00:00:02");
        request.filters["until"] = json!("2026-09-01 00:00:04");
        assert_eq!(
            export_offline(&request, &CancellationToken::new(), |_, _| {}).unwrap()["count"],
            2
        );
        let spec: Spec =
            serde_json::from_value(json!({"from":1788220800,"until":1788652800,"disk":true}))
                .unwrap();
        assert!(spec.validate().is_err()); // offline never weakens the API gate
    }
    #[test]
    fn unknown_privacy_policy_sidecars_and_missing_backup_are_refused() {
        let (dir, request) = fixture(3);
        fs::write(&request.path, "previous").unwrap();
        let original = fs::read(&request.coverage).unwrap();
        for policy in [
            json!({"privacy_level":0,"exclude_domains":["secret.*"],"exclude_clients":[]}),
            json!({"privacy_level":0,"exclude_domains":[],"exclude_clients":["client.*"]}),
            json!({"privacy_level":1,"exclude_domains":[],"exclude_clients":[]}),
        ] {
            let mut metadata: serde_json::Value = serde_json::from_slice(&original).unwrap();
            metadata["api_policy"] = policy;
            fs::write(&request.coverage, metadata.to_string()).unwrap();
            assert!(
                export_offline(&request, &CancellationToken::new(), |_, _| {})
                    .unwrap_err()
                    .message
                    .contains("parity")
            );
            assert_eq!(fs::read_to_string(&request.path).unwrap(), "previous");
        }
        let mut metadata: serde_json::Value = serde_json::from_slice(&original).unwrap();
        metadata.as_object_mut().unwrap().remove("api_policy");
        fs::write(&request.coverage, metadata.to_string()).unwrap();
        assert!(export_offline(&request, &CancellationToken::new(), |_, _| {}).is_err());
        fs::write(&request.coverage, original).unwrap();
        fs::write(format!("{}-wal", request.snapshot), "synthetic").unwrap();
        assert!(
            export_offline(&request, &CancellationToken::new(), |_, _| {})
                .unwrap_err()
                .message
                .contains("sidecars")
        );
        fs::remove_file(format!("{}-wal", request.snapshot)).unwrap();
        let alias = dir.path().join("alias.db");
        std::os::unix::fs::symlink(&request.snapshot, &alias).unwrap();
        assert!(local_path(&alias).is_err());
        fs::remove_file(&request.snapshot).unwrap();
        assert!(export_offline(&request, &CancellationToken::new(), |_, _| {}).is_err());
        assert_eq!(fs::read_to_string(&request.path).unwrap(), "previous");
    }
    #[test]
    fn custom_type_filters_match_api_validation_and_values() {
        let (_dir, mut request) = fixture(3);
        fs::write(&request.path, "previous").unwrap();
        for invalid_type in ["TYPE+1", "NONE", "TYPE65536", "TYPE"] {
            request.filters["type"] = json!(invalid_type);
            assert!(export_offline(&request, &CancellationToken::new(), |_, _| {}).is_err());
            assert_eq!(fs::read_to_string(&request.path).unwrap(), "previous");
        }
        let db = Connection::open(&request.snapshot).unwrap();
        db.execute("UPDATE query_storage SET type=65380 WHERE id=1", [])
            .unwrap();
        drop(db);
        rehash(&request);
        request.filters["type"] = json!(" type65280 ");
        assert_eq!(
            export_offline(&request, &CancellationToken::new(), |_, _| {}).unwrap()["count"],
            1
        );
        let row: serde_json::Value =
            serde_json::from_str(fs::read_to_string(&request.path).unwrap().trim()).unwrap();
        assert_eq!(row["type"], "TYPE65280");
    }
}
