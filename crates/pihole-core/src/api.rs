use crate::{Auth, Connection, Error, Page, Result, Session, Spec};
use reqwest::{Client, Method, Url};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct Timer<'a>(&'a AtomicU64, Instant);
impl Drop for Timer<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(
            self.1.elapsed().as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }
}
pub struct Api {
    client: Client,
    network_us: AtomicU64,
    decode_us: AtomicU64,
    pub cancel: CancellationToken,
}
impl Api {
    pub fn new(cancel: CancellationToken) -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|_| Error::new("NetworkError", "Unable to initialize HTTP client"))?;
        Ok(Self {
            client,
            cancel,
            network_us: AtomicU64::new(0),
            decode_us: AtomicU64::new(0),
        })
    }
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        sid: Option<&str>,
        body: Option<Value>,
    ) -> Result<T> {
        let network_timer = Timer(&self.network_us, Instant::now());
        let mut response = None;
        let mut timed_out = false;
        for _ in 0..3 {
            let mut builder = self.client.request(method.clone(), url.clone());
            if let Some(sid) = sid {
                builder = builder.header("X-FTL-SID", sid);
            }
            if let Some(ref body) = body {
                builder = builder.json(body);
            }
            let result = tokio::select! {
                () = self.cancel.cancelled() => return Err(Error::cancelled()),
                result = builder.send() => result,
            };
            match result {
                Ok(reply) => {
                    response = Some(reply);
                    break;
                }
                Err(error) => timed_out = error.is_timeout(),
            }
        }
        let response = response.ok_or_else(|| {
            Error::new(
                "NetworkError",
                if timed_out {
                    "Network request timed out after 3 attempts"
                } else {
                    "Network request failed after 3 attempts"
                },
            )
        })?;
        let status = response.status();
        if status.as_u16() == 204 {
            return serde_json::from_value(Value::Null)
                .map_err(|_| Error::new("DecodeError", "Unexpected empty response"));
        }
        let bytes = tokio::select! {
            () = self.cancel.cancelled() => return Err(Error::cancelled()),
            result = response.bytes() => result.map_err(|_| Error::new("DecodeError", "Invalid API JSON response"))?,
        };
        drop(network_timer);
        let _decode_timer = Timer(&self.decode_us, Instant::now());
        if status.is_success() {
            return serde_json::from_slice(&bytes)
                .map_err(|_| Error::new("DecodeError", "Invalid API response schema"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new("DecodeError", "Invalid API JSON response"))?;
        if !status.is_success() {
            return Err(Error {
                status: Some(status.as_u16()),
                key: Some(value["error"]["key"].as_str().unwrap_or("api_error").into()),
                ..Error::new(
                    "ApiError",
                    if status.as_u16() == 504 {
                        "Pi-hole API request timed out (HTTP 504)"
                    } else if url.path() == "/api/queries" {
                        "Pi-hole API request failed; see HTTP status"
                    } else {
                        value["error"]["message"]
                            .as_str()
                            .or(value["session"]["message"].as_str())
                            .unwrap_or("Pi-hole API request failed")
                    },
                )
            });
        }
        serde_json::from_value(value)
            .map_err(|_| Error::new("DecodeError", "Invalid API response schema"))
    }
    pub(crate) fn timings(&self) -> (u64, u64) {
        (
            self.network_us.load(Ordering::Relaxed),
            self.decode_us.load(Ordering::Relaxed),
        )
    }
    pub(crate) fn record_timings(
        &self,
        log: &mut crate::diagnostics::Diagnostic,
        before: (u64, u64),
    ) {
        let after = self.timings();
        log.network_us = after.0.saturating_sub(before.0);
        log.decode_us = after.1.saturating_sub(before.1);
    }
    pub async fn authenticate(&self, base: &str, auth: &Auth) -> Result<Connection> {
        let (method, sid, body) = match auth.auth_method.as_str() {
            "password" => {
                let mut body = json!({"password": auth.secret});
                if !auth.totp.trim().is_empty() {
                    body["totp"] = json!(auth.totp.trim());
                }
                (Method::POST, None, Some(body))
            }
            "session" if !auth.secret.trim().is_empty() => {
                (Method::GET, Some(auth.secret.trim()), None)
            }
            "none" => (Method::GET, None, None),
            _ => {
                return Err(Error::new(
                    "ValidationError",
                    "Enter a valid authentication method and session ID",
                ));
            }
        };
        #[derive(serde::Deserialize)]
        struct Response {
            session: Session,
        }
        let response: Response = self
            .request(method, endpoint(base, "/api/auth")?, sid, body)
            .await?;
        let mut session = response.session;
        if !session.valid {
            return Err(Error {
                status: Some(401),
                key: Some("unauthorized".into()),
                ..Error::new(
                    "ApiError",
                    session.message.unwrap_or("Authentication failed".into()),
                )
            });
        }
        let owned_session = auth.auth_method == "password" && session.sid.is_some();
        if let Some(sid) = sid {
            session.sid = Some(sid.into());
        }
        Ok(Connection {
            base_url: base.trim_end_matches('/').into(),
            session,
            owned_session,
        })
    }
    pub async fn logout(&self, connection: &Connection) -> Result<()> {
        if connection.owned_session && connection.session.sid.is_some() {
            let result = self
                .request::<Value>(
                    Method::DELETE,
                    endpoint(&connection.base_url, "/api/auth")?,
                    connection.session.sid.as_deref(),
                    None,
                )
                .await;
            if let Err(error) = result
                && error.status != Some(404)
            {
                return Err(error);
            }
        }
        Ok(())
    }
    /// Complete interactive result, with sequential pages over one pooled HTTP client.
    /// The caller already retains all rows for the workbench; disk export stays streaming.
    pub async fn query(&self, connection: &Connection, spec: &Spec) -> Result<Vec<crate::Query>> {
        let before = self.timings();
        let mut log = crate::diagnostics::Diagnostic::new("query", "none");
        let result = self.query_tracked(connection, spec, &mut log).await;
        self.record_timings(&mut log, before);
        log.finish(&result);
        result
    }
    async fn query_tracked(
        &self,
        connection: &Connection,
        spec: &Spec,
        log: &mut crate::diagnostics::Diagnostic,
    ) -> Result<Vec<crate::Query>> {
        let mut rows = Vec::new();
        let mut cursor = None;
        loop {
            log.phase("waiting");
            let page = self
                .page(connection, spec, rows.len(), cursor, 10_000)
                .await?;
            log.phase("collecting");
            log.pages += 1;
            cursor = cursor.or(page.cursor);
            let count = page.queries.len();
            rows.extend(page.queries);
            log.rows = rows.len();
            if count < 10_000 || rows.len() >= page.records_filtered {
                return Ok(rows);
            }
        }
    }
    /// One explicit interactive page (desktop navigation), with the same local diagnostics.
    pub async fn query_page(
        &self,
        connection: &Connection,
        spec: &Spec,
        start: usize,
        cursor: Option<i64>,
        length: usize,
    ) -> Result<Page> {
        let before = self.timings();
        let mut log = crate::diagnostics::Diagnostic::new("query_page", "none");
        log.phase("waiting");
        let result = self.page(connection, spec, start, cursor, length).await;
        if let Ok(page) = &result {
            log.pages = 1;
            log.rows = page.queries.len();
        }
        self.record_timings(&mut log, before);
        log.finish(&result);
        result
    }
    pub async fn page(
        &self,
        connection: &Connection,
        spec: &Spec,
        start: usize,
        cursor: Option<i64>,
        length: usize,
    ) -> Result<Page> {
        spec.validate()?;
        if !(1..=10_000).contains(&length) {
            return Err(Error::new(
                "ValidationError",
                "Page size must be between 1 and 10000",
            ));
        }
        let mut url = endpoint(&connection.base_url, "/api/queries")?;
        {
            let mut params = url.query_pairs_mut();
            params
                .append_pair("from", &spec.from.to_string())
                .append_pair("until", &spec.until.to_string())
                .append_pair("disk", &spec.disk.to_string())
                .append_pair("start", &start.to_string())
                .append_pair("length", &length.to_string());
            for (name, value) in spec.filters() {
                if !value.trim().is_empty() {
                    params.append_pair(name, value.trim());
                }
            }
            if let Some(cursor) = cursor {
                params.append_pair("cursor", &cursor.to_string());
            }
        }
        self.request(Method::GET, url, connection.session.sid.as_deref(), None)
            .await
    }
    pub async fn suggestions(&self, connection: &Connection) -> Result<Value> {
        let value: Value = self
            .request(
                Method::GET,
                endpoint(&connection.base_url, "/api/queries/suggestions")?,
                connection.session.sid.as_deref(),
                None,
            )
            .await?;
        let suggestions = &value["suggestions"];
        for key in [
            "domain",
            "client_ip",
            "client_name",
            "upstream",
            "type",
            "status",
            "reply",
            "dnssec",
        ] {
            if !suggestions[key]
                .as_array()
                .is_some_and(|v| v.iter().all(Value::is_string))
            {
                return Err(Error::new("DecodeError", "Invalid suggestions response"));
            }
        }
        Ok(suggestions.clone())
    }
    pub async fn mutate(&self, connection: &Connection, domain: &str, action: &str) -> Result<()> {
        let kind = match action {
            "block" => "deny",
            "unblock" => "allow",
            _ => return Err(Error::new("ValidationError", "Invalid domain action")),
        };
        self.request::<Value>(Method::POST, endpoint(&connection.base_url, &format!("/api/domains/{kind}/exact"))?, connection.session.sid.as_deref(),
            Some(json!({"domain":domain,"comment":"Added from Query Log","type":kind,"kind":"exact"}))).await?;
        Ok(())
    }
}
fn endpoint(base: &str, path: &str) -> Result<Url> {
    let url = Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|_| Error::new("ValidationError", "Invalid Pi-hole URL"))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(Error::new(
            "ValidationError",
            "Pi-hole requires HTTP or HTTPS",
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod timeout_tests {
    use super::*;
    #[tokio::test]
    async fn a_slow_server_returns_a_timeout_error_after_sequential_attempts() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let sockets: Vec<_> = (0..3).map(|_| listener.accept().unwrap().0).collect();
            std::thread::sleep(Duration::from_millis(150));
            drop(sockets);
        });
        let api = Api {
            client: Client::builder()
                .timeout(Duration::from_millis(30))
                .build()
                .unwrap(),
            cancel: CancellationToken::new(),
            network_us: AtomicU64::new(0),
            decode_us: AtomicU64::new(0),
        };
        let error = api
            .request::<Value>(
                Method::GET,
                Url::parse(&format!("http://{address}/api/queries")).unwrap(),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        server.join().unwrap();
    }
}
