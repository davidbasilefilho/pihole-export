use crate::{Auth, Connection, Error, Page, Result, Session, Spec};
use reqwest::{Client, Method, Url};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct Api {
    client: Client,
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
        Ok(Self { client, cancel })
    }
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        sid: Option<&str>,
        body: Option<Value>,
    ) -> Result<T> {
        let mut response = None;
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
            if let Ok(reply) = result {
                response = Some(reply);
                break;
            }
        }
        let response = response
            .ok_or_else(|| Error::new("NetworkError", "Network request failed after 3 attempts"))?;
        let status = response.status();
        if status.as_u16() == 204 {
            return serde_json::from_value(Value::Null)
                .map_err(|_| Error::new("DecodeError", "Unexpected empty response"));
        }
        let value: Value = tokio::select! {
            () = self.cancel.cancelled() => return Err(Error::cancelled()),
            result = response.json() => result.map_err(|_| Error::new("DecodeError", "Invalid API JSON response"))?,
        };
        if !status.is_success() {
            return Err(Error {
                status: Some(status.as_u16()),
                key: Some(value["error"]["key"].as_str().unwrap_or("api_error").into()),
                ..Error::new(
                    "ApiError",
                    value["error"]["message"]
                        .as_str()
                        .or(value["session"]["message"].as_str())
                        .unwrap_or("Pi-hole API request failed"),
                )
            });
        }
        serde_json::from_value(value)
            .map_err(|_| Error::new("DecodeError", "Invalid API response schema"))
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
