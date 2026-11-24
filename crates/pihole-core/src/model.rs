use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct Error {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.tag, self.message)
    }
}
impl std::error::Error for Error {}
impl Error {
    pub fn new(tag: &'static str, message: impl Into<String>) -> Self {
        Self {
            tag,
            message: message.into(),
            path: None,
            status: None,
            key: None,
        }
    }
    pub fn write(path: &str, error: impl std::fmt::Display) -> Self {
        Self {
            path: Some(path.into()),
            ..Self::new("WriteError", error.to_string())
        }
    }
    pub fn cancelled() -> Self {
        Self::new("Cancelled", "Export cancelled")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Deserialize, Serialize)]
pub struct Client {
    pub ip: String,
    pub name: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Reply {
    pub r#type: Option<String>,
    pub time: f64,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Ede {
    pub code: i64,
    pub text: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Query {
    pub id: i64,
    pub time: f64,
    pub r#type: String,
    pub domain: String,
    pub cname: Option<String>,
    pub status: Option<String>,
    pub client: Client,
    pub dnssec: Option<String>,
    pub reply: Reply,
    pub list_id: Option<i64>,
    pub upstream: Option<String>,
    pub ede: Ede,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Page {
    pub queries: Vec<Query>,
    pub cursor: Option<i64>,
    #[serde(rename = "recordsTotal")]
    pub records_total: usize,
    #[serde(rename = "recordsFiltered")]
    pub records_filtered: usize,
    pub draw: i64,
    pub earliest_timestamp: f64,
    pub earliest_timestamp_disk: f64,
    pub took: Option<f64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub session: Session,
    pub owned_session: bool,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Session {
    pub valid: bool,
    pub sid: Option<String>,
    pub csrf: Option<String>,
    pub validity: f64,
    pub totp: bool,
    pub message: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    pub auth_method: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub totp: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub from: f64,
    pub until: f64,
    pub disk: bool,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub client_ip: String,
    #[serde(default)]
    pub client_name: String,
    #[serde(default)]
    pub upstream: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub reply: String,
    #[serde(default)]
    pub dnssec: String,
}
impl Spec {
    pub fn validate(&self) -> Result<()> {
        if !self.from.is_finite() || !self.until.is_finite() || self.until <= self.from {
            return Err(Error::new(
                "ValidationError",
                "Until must be later than From",
            ));
        }
        if self.until - self.from > 48.0 * 3600.0 {
            return Err(Error::new(
                "ValidationError",
                "Ranges longer than 48 hours are blocked: DNS load has not been validated. No query was sent.",
            ));
        }
        Ok(())
    }
    pub fn heavy(&self) -> bool {
        self.until - self.from > 48.0 * 3600.0
            && self.filters().iter().all(|(_, v)| v.trim().is_empty())
    }
    pub fn filters(&self) -> [(&str, &str); 8] {
        [
            ("domain", &self.domain),
            ("client_ip", &self.client_ip),
            ("client_name", &self.client_name),
            ("upstream", &self.upstream),
            ("type", &self.r#type),
            ("status", &self.status),
            ("reply", &self.reply),
            ("dnssec", &self.dnssec),
        ]
    }
}
pub fn local_time(input: &str, timezone: &str) -> Result<f64> {
    let zone: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| Error::new("ValidationError", "Invalid timezone"))?;
    let date = [
        "%d/%m/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(input.trim(), format).ok())
    .or_else(|| {
        ["%d/%m/%Y", "%Y-%m-%d"].iter().find_map(|format| {
            NaiveDate::parse_from_str(input.trim(), format)
                .ok()?
                .and_hms_opt(0, 0, 0)
        })
    })
    .ok_or_else(|| Error::new("ValidationError", "Invalid local date/time"))?;
    if !(1..=9999).contains(&date.year()) || date.nanosecond() >= 1_000_000_000 {
        return Err(Error::new("ValidationError", "Invalid local date/time"));
    }
    let instant = zone.from_local_datetime(&date).single().ok_or_else(|| {
        Error::new(
            "ValidationError",
            "Ambiguous or nonexistent local date/time",
        )
    })?;
    Ok(instant.timestamp() as f64)
}
pub fn spec_from_form(mut form: Value) -> Result<Spec> {
    let zone = form["timezone"].as_str().unwrap_or("UTC").to_owned();
    for key in ["from", "until"] {
        form[key] = Value::from(local_time(form[key].as_str().unwrap_or(""), &zone)?);
    }
    let spec: Spec = serde_json::from_value(form)
        .map_err(|_| Error::new("ValidationError", "Invalid filters"))?;
    spec.validate()?;
    Ok(spec)
}
