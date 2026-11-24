//! Local, bounded, allowlisted diagnostics. Never serialize an API error or request.
use crate::{Error, Result};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    time::Instant,
};

pub fn logs_directory() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Logs"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| PathBuf::from(p).is_absolute())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")));
    root.map(|p| p.join("pihole-export/logs"))
}

pub(crate) struct Diagnostic {
    file: Option<File>,
    id: String,
    operation: &'static str,
    format: &'static str,
    started: Instant,
    phase_started: Instant,
    phase: &'static str,
    network_decode_ms: u128,
    pub network_us: u64,
    pub decode_us: u64,
    pub local_read_us: u128,
    write_ms: u128,
    finalize_ms: u128,
    pub pages: usize,
    pub rows: usize,
}
impl Diagnostic {
    pub fn new(operation: &'static str, format: &str) -> Self {
        Self::at(logs_directory(), operation, format)
    }
    pub(crate) fn at(directory: Option<PathBuf>, operation: &'static str, format: &str) -> Self {
        let id = format!(
            "{}-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            std::process::id()
        );
        let file = directory.and_then(|directory| {
            fs::create_dir_all(&directory).ok()?;
            // Only our diagnostic files participate. Each has at most two small records.
            let mut files: Vec<_> = fs::read_dir(&directory)
                .ok()?
                .flatten()
                .filter(|e| {
                    e.file_name().to_string_lossy().starts_with("operation-")
                        && e.path().extension().is_some_and(|e| e == "jsonl")
                })
                .map(|e| e.path())
                .collect();
            files.sort();
            let excess = files.len().saturating_sub(31);
            for path in files.into_iter().take(excess) {
                let _ = fs::remove_file(path);
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(directory.join(format!("operation-{id}.jsonl")))
                .ok()
        });
        let mut result = Self {
            file,
            id,
            operation,
            format: match format {
                "csv" => "csv",
                "jsonl" => "jsonl",
                "sqlite" => "sqlite",
                "parquet" => "parquet",
                _ => "none",
            },
            started: Instant::now(),
            phase_started: Instant::now(),
            phase: "preparing",
            network_decode_ms: 0,
            network_us: 0,
            decode_us: 0,
            local_read_us: 0,
            write_ms: 0,
            finalize_ms: 0,
            pages: 0,
            rows: 0,
        };
        result.record("started", None);
        result
    }
    pub fn phase(&mut self, phase: &'static str) {
        let elapsed = self.phase_started.elapsed().as_millis();
        match self.phase {
            "waiting" => self.network_decode_ms += elapsed,
            "writing" => self.write_ms += elapsed,
            "finalizing" => self.finalize_ms += elapsed,
            _ => {}
        }
        self.phase = phase;
        self.phase_started = Instant::now();
    }
    pub fn finish<T>(&mut self, result: &Result<T>) {
        self.phase("finished");
        let (outcome, cause) = match result {
            Ok(_) if self.rows == 0 => ("zero_results", None),
            Ok(_) => ("success", None),
            Err(e) if e.tag == "Cancelled" => ("cancelled", Some("cancelled")),
            Err(e) => ("error", Some(safe_cause(e))),
        };
        self.record(outcome, cause);
    }
    fn record(&mut self, outcome: &'static str, cause: Option<&'static str>) {
        let value = json!({"timestamp":chrono::Utc::now().to_rfc3339(), "version":env!("CARGO_PKG_VERSION"), "operation_id":self.id, "operation":self.operation, "format":self.format, "outcome":outcome, "cause":cause, "total_ms":self.started.elapsed().as_millis(), "network_decode_ms":self.network_decode_ms, "network_us":self.network_us, "decode_us":self.decode_us, "local_read_us":self.local_read_us, "write_ms":self.write_ms, "finalize_ms":self.finalize_ms, "pages":self.pages, "rows":self.rows});
        if let Some(file) = self.file.as_mut() {
            let _ = writeln!(file, "{value}");
        }
    }
}
fn safe_cause(error: &Error) -> &'static str {
    match error.tag {
        "NetworkError"
            if matches!(
                error.message.as_str(),
                "Network request timed out after 3 attempts"
                    | "Network response body timed out"
                    | "Network request timed out (not retried)"
            ) =>
        {
            "network_timeout"
        }
        "NetworkError" => "network_failure",
        "DecodeError" => "invalid_response",
        "WriteError" => "write_failure",
        "ValidationError" => "invalid_input",
        "ApiError" if error.status == Some(504) => "api_timeout",
        "ApiError" => "api_rejected_request",
        _ => "operation_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_allowlisted_zero_failure_and_bounded_retention() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..40 {
            let mut log = Diagnostic::at(Some(dir.path().into()), "export", "csv");
            log.phase("waiting");
            let result = if i == 39 {
                Err(Error::new("ApiError", "secret SID URL domain output-path"))
            } else {
                Ok(())
            };
            log.finish(&result);
        }
        let files: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(files.len(), 32);
        let all = files
            .iter()
            .map(|f| fs::read_to_string(f.path()).unwrap())
            .collect::<String>();
        assert!(all.contains("zero_results"));
        assert!(all.contains("api_rejected_request"));
        assert!(!all.contains("secret"));
        assert!(!all.contains("output-path"));
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "synthetic").unwrap();
        let mut failed = Diagnostic::at(Some(blocker.join("logs")), "query", "none");
        failed.finish(&Ok(())); // logging failure never becomes an operation failure
    }
}
