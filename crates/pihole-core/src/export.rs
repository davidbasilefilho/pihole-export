use crate::{Api, Connection, Error, Query, Result, Spec};
use chrono::{DateTime, SecondsFormat};
use parquet::{
    data_type::{ByteArray, ByteArrayType, DoubleType, Int64Type},
    file::{properties::WriterProperties, writer::SerializedFileWriter},
    schema::parser::parse_message_type,
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{BufWriter, Write},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub const COLUMNS: [&str; 16] = [
    "timestamp",
    "time_iso",
    "domain",
    "client_ip",
    "client_name",
    "type",
    "status",
    "reply",
    "reply_time_ms",
    "upstream",
    "dnssec",
    "cname",
    "list_id",
    "ede_code",
    "ede_text",
    "query_id",
];
fn cells(row: &Query) -> Result<Vec<Value>> {
    let millis = (row.time * 1000.0).trunc() as i64;
    let iso = DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| Error::new("DecodeError", "Invalid query timestamp"))?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(vec![
        json!(row.time),
        json!(iso),
        json!(row.domain),
        json!(row.client.ip),
        json!(row.client.name),
        json!(row.r#type),
        json!(row.status),
        json!(row.reply.r#type),
        json!(row.reply.time),
        json!(row.upstream),
        json!(row.dnssec),
        json!(row.cname),
        json!(row.list_id),
        json!(row.ede.code),
        json!(row.ede.text),
        json!(row.id),
    ])
}
fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
}
enum Sink {
    Csv(Box<csv::Writer<BufWriter<File>>>),
    Jsonl(BufWriter<File>),
    Sqlite(rusqlite::Connection),
    Parquet(Box<SerializedFileWriter<File>>),
}
pub struct Exporter {
    path: String,
    format: String,
    sink: Sink,
    count: usize,
}
impl Exporter {
    pub fn new(path: &str, format: &str) -> Result<Self> {
        let fail = |e: Box<dyn std::error::Error>| Error::write(path, e);
        let sink = (|| -> std::result::Result<Sink, Box<dyn std::error::Error>> {
            Ok(match format {
                "csv" => {
                    let mut writer = csv::WriterBuilder::new()
                        .terminator(csv::Terminator::CRLF)
                        .from_writer(BufWriter::new(File::create(path)?));
                    writer.write_record(COLUMNS)?;
                    writer.flush()?;
                    Sink::Csv(Box::new(writer))
                }
                "jsonl" => Sink::Jsonl(BufWriter::new(File::create(path)?)),
                "sqlite" => {
                    let db = rusqlite::Connection::open(path)?;
                    let schema = COLUMNS
                        .iter()
                        .enumerate()
                        .map(|(i, name)| {
                            format!(
                                "{name} {}",
                                match i {
                                    0 | 8 => "REAL",
                                    12 | 13 | 15 => "INTEGER",
                                    _ => "TEXT",
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    db.execute_batch(&format!(
                        "DROP TABLE IF EXISTS queries; CREATE TABLE queries ({schema});"
                    ))?;
                    Sink::Sqlite(db)
                }
                "parquet" => {
                    let schema = COLUMNS
                        .iter()
                        .enumerate()
                        .map(|(i, name)| {
                            format!(
                                "OPTIONAL {} {name}{};",
                                match i {
                                    0 | 8 => "DOUBLE",
                                    12 | 13 | 15 => "INT64",
                                    _ => "BINARY",
                                },
                                if matches!(i, 0 | 8 | 12 | 13 | 15) {
                                    ""
                                } else {
                                    " (UTF8)"
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    Sink::Parquet(Box::new(SerializedFileWriter::new(
                        File::create(path)?,
                        Arc::new(parse_message_type(&format!(
                            "message queries {{ {schema} }}"
                        ))?),
                        Arc::new(WriterProperties::builder().build()),
                    )?))
                }
                _ => return Err("Unsupported export format".into()),
            })
        })()
        .map_err(fail)?;
        Ok(Self {
            path: path.into(),
            format: format.into(),
            sink,
            count: 0,
        })
    }
    pub fn write(&mut self, rows: &[Query], cancel: &CancellationToken) -> Result<()> {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        let data = rows.iter().map(cells).collect::<Result<Vec<_>>>()?;
        (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
            match &mut self.sink {
                Sink::Csv(writer) => {
                    for cells in &data {
                        writer.write_record(cells.iter().map(text))?;
                    }
                    writer.flush()?;
                }
                Sink::Jsonl(writer) => {
                    for cells in &data {
                        use serde::ser::{SerializeMap, Serializer};
                        let mut serializer = serde_json::Serializer::new(&mut *writer);
                        let mut record = serializer.serialize_map(Some(COLUMNS.len()))?;
                        for (name, value) in COLUMNS.iter().zip(cells) {
                            record.serialize_entry(name, value)?;
                        }
                        record.end()?;
                        writer.write_all(b"\n")?;
                    }
                    writer.flush()?;
                }
                Sink::Sqlite(db) => {
                    let tx = db.transaction()?;
                    {
                        let mut statement = tx.prepare_cached(
                            "INSERT INTO queries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        )?;
                        for row in &data {
                            let values = row
                                .iter()
                                .map(|v| match v {
                                    Value::Null => rusqlite::types::Value::Null,
                                    Value::Number(n) if n.is_i64() => {
                                        rusqlite::types::Value::Integer(n.as_i64().unwrap())
                                    }
                                    Value::Number(n) => {
                                        rusqlite::types::Value::Real(n.as_f64().unwrap())
                                    }
                                    _ => rusqlite::types::Value::Text(text(v)),
                                })
                                .collect::<Vec<_>>();
                            statement.execute(rusqlite::params_from_iter(values))?;
                        }
                    }
                    tx.commit()?;
                }
                Sink::Parquet(writer) if !data.is_empty() => {
                    let mut group = writer.next_row_group()?;
                    for i in 0..COLUMNS.len() {
                        let mut column = group.next_column()?.ok_or("Missing Parquet column")?;
                        let levels = data
                            .iter()
                            .map(|r| i16::from(!r[i].is_null()))
                            .collect::<Vec<_>>();
                        let values = data
                            .iter()
                            .filter_map(|r| (!r[i].is_null()).then_some(&r[i]))
                            .collect::<Vec<_>>();
                        match i {
                            0 | 8 => {
                                column.typed::<DoubleType>().write_batch(
                                    &values
                                        .iter()
                                        .map(|v| v.as_f64().unwrap())
                                        .collect::<Vec<_>>(),
                                    Some(&levels),
                                    None,
                                )?;
                            }
                            12 | 13 | 15 => {
                                column.typed::<Int64Type>().write_batch(
                                    &values
                                        .iter()
                                        .map(|v| v.as_i64().unwrap())
                                        .collect::<Vec<_>>(),
                                    Some(&levels),
                                    None,
                                )?;
                            }
                            _ => {
                                column.typed::<ByteArrayType>().write_batch(
                                    &values
                                        .iter()
                                        .map(|v| ByteArray::from(text(v).as_str()))
                                        .collect::<Vec<_>>(),
                                    Some(&levels),
                                    None,
                                )?;
                            }
                        }
                        column.close()?;
                    }
                    group.close()?;
                }
                Sink::Parquet(_) => {}
            }
            Ok(())
        })()
        .map_err(|e| Error::write(&self.path, e))?;
        self.count += rows.len();
        Ok(())
    }
    pub fn finish(mut self) -> Result<Value> {
        (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
            match &mut self.sink {
                Sink::Csv(w) => w.flush()?, Sink::Jsonl(w) => w.flush()?,
                Sink::Sqlite(db) => db.execute_batch("CREATE INDEX queries_time ON queries(timestamp); CREATE INDEX queries_domain ON queries(domain);")?,
                Sink::Parquet(w) => { w.finish()?; }
            } Ok(())
        })().map_err(|e| Error::write(&self.path, e))?;
        Ok(json!({"path": self.path, "count": self.count, "format": self.format}))
    }
}
impl Api {
    pub async fn export(
        &self,
        connection: &Connection,
        spec: &Spec,
        path: &str,
        format: &str,
    ) -> Result<Value> {
        self.export_progress(connection, spec, path, format, |_, _| {})
            .await
    }
    pub async fn export_progress(
        &self,
        connection: &Connection,
        spec: &Spec,
        path: &str,
        format: &str,
        progress: impl FnMut(&'static str, usize),
    ) -> Result<Value> {
        let before = self.timings();
        let mut log = crate::diagnostics::Diagnostic::new("export", format);
        let result = self
            .export_tracked(connection, spec, path, format, progress, &mut log)
            .await;
        self.record_timings(&mut log, before);
        log.finish(&result);
        result
    }
    #[allow(clippy::too_many_arguments)]
    async fn export_tracked(
        &self,
        connection: &Connection,
        spec: &Spec,
        path: &str,
        format: &str,
        mut progress: impl FnMut(&'static str, usize),
        log: &mut crate::diagnostics::Diagnostic,
    ) -> Result<Value> {
        spec.validate()?;
        log.phase("writing");
        let mut writer = Exporter::new(path, format)?;
        let (mut start, mut cursor) = (0, None);
        loop {
            log.phase("waiting");
            progress("waiting", start);
            let page = self.page(connection, spec, start, cursor, 10_000).await?;
            if cursor.is_none() {
                cursor = page.cursor;
            }
            log.pages += 1;
            log.phase("writing");
            progress("writing", start);
            writer.write(&page.queries, &self.cancel)?;
            start += page.queries.len();
            log.rows = start;
            if page.queries.len() < 10_000 || start >= page.records_filtered {
                break;
            }
        }
        if self.cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        log.phase("finalizing");
        progress("finalizing", start);
        writer.finish()
    }
}
