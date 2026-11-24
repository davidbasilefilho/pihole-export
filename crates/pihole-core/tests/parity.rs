use pihole_core::{Exporter, Query, Spec, local_time};
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn row() -> Query {
    serde_json::from_value(json!({"id":42,"time":1788220800.125,"type":"A","domain":"a,\"é\"\n.example","cname":null,"status":"FORWARDED","client":{"ip":"192.0.2.1","name":null},"dnssec":null,"reply":{"type":"IP","time":1.25},"list_id":123,"upstream":null,"ede":{"code":0,"text":null}})).unwrap()
}
#[test]
fn temporal_boundaries_and_heavy_guard() {
    assert_eq!(
        local_time("01/09/2026 00:00:00", "UTC").unwrap(),
        1788220800.0
    );
    assert_eq!(
        local_time("2026-09-01T00:00:00", "America/Sao_Paulo").unwrap(),
        1788231600.0
    );
    for time in [
        "2026-03-08 02:30:00",
        "2026-11-01 01:30:00",
        "2026-02-30 00:00:00",
        "0000-01-01 00:00:00",
        "2026-12-31 23:59:60",
    ] {
        assert!(local_time(time, "America/New_York").is_err());
    }
    assert!(local_time("2026-09-01 00:00:00", "invalid").is_err());
    let mut spec: Spec =
        serde_json::from_value(json!({"from":1,"until":172801,"disk":true})).unwrap();
    assert!(!spec.heavy());
    spec.until += 1.0;
    assert!(spec.heavy());
    spec.domain = "example.*".into();
    assert!(!spec.heavy());
    spec.until = spec.from;
    assert!(spec.validate().is_err());
}
#[test]
fn four_formats_round_trip_nullable_numeric_unicode_fields() {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    use parquet::record::RowAccessor;
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    for format in ["csv", "jsonl", "sqlite", "parquet"] {
        let path = dir.path().join(format);
        let mut writer = Exporter::new(path.to_str().unwrap(), format).unwrap();
        writer.write(&[row()], &cancel).unwrap();
        writer.write(&[row()], &cancel).unwrap();
        assert_eq!(writer.finish().unwrap()["count"], 2);
        match format {
            "csv" => {
                let mut reader = csv::Reader::from_path(path).unwrap();
                let rows = reader
                    .records()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap();
                assert_eq!(rows.len(), 2);
                assert_eq!(&rows[0][2], row().domain);
                assert_eq!(&rows[0][1], "2026-09-01T00:00:00.125Z");
            }
            "jsonl" => {
                let raw = std::fs::read_to_string(path).unwrap();
                let first: serde_json::Value =
                    serde_json::from_str(raw.lines().next().unwrap()).unwrap();
                assert_eq!(first["list_id"], 123);
                assert!(first["client_name"].is_null());
                assert_eq!(first["domain"], row().domain);
            }
            "sqlite" => {
                let db = rusqlite::Connection::open(path).unwrap();
                let value: (String, Option<String>, i64) = db
                    .query_row(
                        "SELECT domain,client_name,list_id FROM queries LIMIT 1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .unwrap();
                assert_eq!(value, (row().domain, None, 123));
            }
            _ => {
                let reader = SerializedFileReader::new(std::fs::File::open(path).unwrap()).unwrap();
                assert_eq!(reader.metadata().file_metadata().num_rows(), 2);
                let first = reader.get_row_iter(None).unwrap().next().unwrap().unwrap();
                assert_eq!(first.get_string(2).unwrap(), &row().domain);
                assert_eq!(first.get_long(12).unwrap(), 123);
            }
        }
    }
}
#[test]
fn empty_exports_and_write_errors_and_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    for format in ["csv", "jsonl", "sqlite", "parquet"] {
        let path = dir.path().join(format);
        assert_eq!(
            Exporter::new(path.to_str().unwrap(), format)
                .unwrap()
                .finish()
                .unwrap()["count"],
            0
        );
        let mut writer = Exporter::new(path.to_str().unwrap(), format).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            writer.write(&[row()], &cancel).unwrap_err().tag,
            "Cancelled"
        );
        assert!(Exporter::new(dir.path().to_str().unwrap(), format).is_err());
        assert!(Exporter::new(dir.path().join("missing/out").to_str().unwrap(), format).is_err());
    }
}

#[test]
fn date_only_uses_local_midnight_and_rejects_invalid_or_missing_midnight() {
    for (date, explicit, zone) in [
        ("01/09/2026", "01/09/2026 00:00:00", "UTC"),
        ("2026-09-01", "2026-09-01 00:00:00", "America/Sao_Paulo"),
        ("2026-03-08", "2026-03-08 00:00:00", "America/New_York"),
    ] {
        assert_eq!(
            local_time(date, zone).unwrap(),
            local_time(explicit, zone).unwrap()
        );
    }
    assert_eq!(
        local_time("2026-03-09", "America/New_York").unwrap()
            - local_time("2026-03-08", "America/New_York").unwrap(),
        23.0 * 3600.0
    );
    for date in ["31/02/2026", "2026-02-30", "0000-01-01"] {
        assert!(local_time(date, "UTC").is_err());
    }
    assert!(local_time("2011-12-30", "Pacific/Apia").is_err());
}
