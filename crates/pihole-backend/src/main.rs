use pihole_core::{Api, Error, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

fn field<T: serde::de::DeserializeOwned>(request: &Value, key: &str) -> Result<T> {
    serde_json::from_value(request[key].clone())
        .map_err(|_| Error::new("ValidationError", format!("Invalid {key}")))
}
async fn execute(request: Value, cancel: CancellationToken) -> Result<Value> {
    if request["op"] == "offline" {
        let input: pihole_core::OfflineRequest = field(&request, "input")?;
        return tokio::task::spawn_blocking(move || {
            pihole_core::export_offline(&input, &cancel, |phase, rows| {
                use std::io::Write;
                println!("{}", json!({"progress":{"phase":phase,"rows":rows}}));
                let _ = std::io::stdout().flush();
            })
        })
        .await
        .map_err(|_| Error::new("ValidationError", "Offline worker failed"))?;
    }
    let api = Api::new(cancel.clone())?;
    match request["op"].as_str().unwrap_or("") {
        "time" => Ok(json!(pihole_core::local_time(
            &field::<String>(&request, "input")?,
            &field::<String>(&request, "timezone")?
        )?)),
        "spec" => Ok(serde_json::to_value(pihole_core::spec_from_form(
            request["filters"].clone(),
        )?)
        .unwrap()),
        "auth" => Ok(serde_json::to_value(
            api.authenticate(
                &field::<String>(&request, "url")?,
                &field(&request, "form")?,
            )
            .await?,
        )
        .unwrap()),
        "logout" => {
            api.logout(&field(&request, "connection")?).await?;
            Ok(Value::Null)
        }
        "suggestions" => api.suggestions(&field(&request, "connection")?).await,
        "mutate" => {
            api.mutate(
                &field(&request, "connection")?,
                &field::<String>(&request, "domain")?,
                &field::<String>(&request, "action")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "query" => Ok(serde_json::to_value(
            api.query(&field(&request, "connection")?, &field(&request, "spec")?)
                .await?,
        )
        .unwrap()),
        "page" => Ok(serde_json::to_value(
            api.page(
                &field(&request, "connection")?,
                &field(&request, "spec")?,
                field(&request, "start")?,
                request["cursor"].as_i64(),
                request["length"].as_u64().unwrap_or(10_000) as usize,
            )
            .await?,
        )
        .unwrap()),
        "export" => {
            api.export_progress(
                &field(&request, "connection")?,
                &field(&request, "spec")?,
                &field::<String>(&request, "path")?,
                &field::<String>(&request, "format")?,
                |phase, rows| {
                    use std::io::Write;
                    println!("{}", json!({"progress":{"phase":phase,"rows":rows}}));
                    let _ = std::io::stdout().flush();
                },
            )
            .await
        }
        "run" => {
            let spec: pihole_core::Spec = field(&request, "spec")?;
            spec.validate()?;
            let path: String = field(&request, "path")?;
            let format: String = field(&request, "format")?;
            let connection = api
                .authenticate(
                    &field::<String>(&request, "url")?,
                    &field(&request, "form")?,
                )
                .await?;
            let result = api.export(&connection, &spec, &path, &format).await;
            let cleanup = Api::new(CancellationToken::new())?;
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                cleanup.logout(&connection),
            )
            .await;
            result
        }
        _ => Err(Error::new("ValidationError", "Unknown backend operation")),
    }
}
fn respond(result: Result<Value>) {
    use std::io::Write;
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error}),
        }
    );
    let _ = std::io::stdout().flush();
}
async fn write_pages(
    request: Value,
    mut lines: tokio::io::Lines<BufReader<tokio::io::Stdin>>,
) -> Result<Value> {
    let mut writer = pihole_core::Exporter::new(
        &field::<String>(&request, "path")?,
        &field::<String>(&request, "format")?,
    )?;
    respond(Ok(Value::Null));
    let cancel = CancellationToken::new();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| Error::new("DecodeError", "Invalid input"))?
    {
        let command: Value =
            serde_json::from_str(&line).map_err(|_| Error::new("DecodeError", "Invalid page"))?;
        if command["finish"] == true {
            return writer.finish();
        }
        if command["cancel"] == true {
            return Err(Error::cancelled());
        }
        writer.write(
            &field::<Vec<pihole_core::Query>>(&command, "rows")?,
            &cancel,
        )?;
        respond(Ok(Value::Null));
    }
    Err(Error::cancelled())
}
async fn serve() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let request = match lines.next_line().await {
        Ok(Some(line)) => serde_json::from_str::<Value>(&line)
            .map_err(|_| Error::new("ValidationError", "Invalid request JSON")),
        _ => Err(Error::new("ValidationError", "Missing request")),
    };
    if let Ok(ref value) = request
        && value["op"] == "write"
    {
        respond(write_pages(value.clone(), lines).await);
        return;
    }
    let cancel = CancellationToken::new();
    let watcher = cancel.clone();
    tokio::spawn(async move {
        if let Ok(Some(_)) = lines.next_line().await {
            watcher.cancel();
        }
    });
    let result = match request {
        Ok(request) => execute(request, cancel).await,
        Err(error) => Err(error),
    };
    respond(result);
}

fn main() {
    let runtime = tokio::runtime::Runtime::new().expect("Tokio runtime");
    runtime.block_on(serve());
    // stdin is a blocking OS read; do not await it during runtime shutdown.
    runtime.shutdown_background();
}
