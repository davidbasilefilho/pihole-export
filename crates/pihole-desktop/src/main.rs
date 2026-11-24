#![forbid(unsafe_code)]
use pihole_core::{Api, Auth, Page, Spec, spec_from_form};
use rune::{
    AppSpec, Cx, El, Latest, ScrollSpec, TextEdit, col, row, text, text_input,
    tok::{self, type_},
};
use rune_kit::{Button, Kit, PaletteSeed};
use tokio_util::sync::CancellationToken;

const LABELS: [&str; 15] = [
    "Pi-hole URL",
    "Password / session ID",
    "TOTP",
    "Timestamp from *",
    "Timestamp until *",
    "Timezone *",
    "Domain †",
    "Client IP †",
    "Client name †",
    "Upstream †",
    "Type",
    "Status",
    "Reply",
    "DNSSEC",
    "Destination (local file)",
];
const AUTH: [&str; 3] = ["password", "session", "none"];
const FORMATS: [&str; 4] = ["csv", "jsonl", "sqlite", "parquet"];
#[derive(Clone, Copy)]
enum Action {
    Query,
    Next,
    Export,
}
enum Output {
    Page(Box<Page>, Box<Spec>, usize, Option<i64>),
    Export(String),
}
struct State {
    fields: [TextEdit; 15],
    date_focused: [bool; 2],
    auth: usize,
    format: usize,
    disk: bool,
    busy: bool,
    status: String,
    preview: String,
    pending: Option<Action>,
    last: Option<(Spec, usize, Option<i64>, usize)>,
    cancel: CancellationToken,
    latest: Latest<Result<Output, String>>,
}
impl Default for State {
    fn default() -> Self {
        let values = [
            "http://127.0.0.1",
            "",
            "",
            "",
            "",
            "UTC",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "pihole.csv",
        ];
        let mut fields = values.map(TextEdit::new);
        fields[1].set_secure(true);
        fields[2].set_secure(true);
        Self {
            fields,
            date_focused: [false; 2],
            auth: 0,
            format: 0,
            disk: true,
            busy: false,
            status:
                "Choose dates and a destination. No request runs until you click Query or Export."
                    .into(),
            preview: String::new(),
            pending: None,
            last: None,
            cancel: CancellationToken::new(),
            latest: Latest::default(),
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
impl State {
    fn sync_date_focus(&mut self) -> bool {
        let mut changed = false;
        for (slot, index) in [3, 4].into_iter().enumerate() {
            let focused = self.fields[index].focused;
            if focused && !self.date_focused[slot] {
                self.fields[index].clear();
                changed = true;
            }
            self.date_focused[slot] = focused;
        }
        changed
    }

    fn spec(&self) -> pihole_core::Result<Spec> {
        let f = &self.fields;
        spec_from_form(
            serde_json::json!({ "from":f[3].text,"until":f[4].text,"timezone":f[5].text,"disk":self.disk,
            "domain":f[6].text,"clientIp":f[7].text,"clientName":f[8].text,"upstream":f[9].text,"type":f[10].text,"status":f[11].text,"reply":f[12].text,"dnssec":f[13].text }),
        )
    }
    fn start(&mut self, action: Action, confirmed: bool) {
        if self.busy {
            return;
        }
        let (spec, start, cursor) = if matches!(action, Action::Next) {
            let Some((spec, start, cursor, total)) = &self.last else {
                return;
            };
            if start >= total {
                return;
            }
            (spec.clone(), *start, *cursor)
        } else {
            match self.spec() {
                Ok(spec) => (spec, 0, None),
                Err(e) => {
                    self.status = e.to_string();
                    return;
                }
            }
        };
        if spec.heavy() && !confirmed && !matches!(action, Action::Next) {
            self.pending = Some(action);
            self.status =
                "More than 48 hours without a text filter. Confirm this potentially heavy query."
                    .into();
            return;
        }
        self.pending = None;
        if matches!(action, Action::Export) && self.fields[14].text.trim().is_empty() {
            self.status = "Enter an export destination".into();
            return;
        }
        self.busy = true;
        self.status = "Working…".into();
        self.cancel = CancellationToken::new();
        let cancel = self.cancel.clone();
        let url = self.fields[0].text.trim().trim_end_matches('/').to_owned();
        let auth = Auth {
            auth_method: AUTH[self.auth].into(),
            secret: self.fields[1].text.clone(),
            totp: self.fields[2].text.clone(),
        };
        let path = self.fields[14].text.trim().to_owned();
        let format = FORMATS[self.format];
        self.latest.request((), move |_| {
            let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            runtime.block_on(async move {
                let api = Api::new(cancel).map_err(|e| e.to_string())?;
                let connection = api
                    .authenticate(&url, &auth)
                    .await
                    .map_err(|e| e.to_string())?;
                let result = if matches!(action, Action::Export) {
                    api.export(&connection, &spec, &path, format)
                        .await
                        .map(|r| Output::Export(format!("Exported {} rows → {}", r["count"], path)))
                } else {
                    api.page(&connection, &spec, start, cursor, 100)
                        .await
                        .map(|page| Output::Page(Box::new(page), Box::new(spec), start, cursor))
                };
                if let Ok(cleanup) = Api::new(CancellationToken::new()) {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        cleanup.logout(&connection),
                    )
                    .await;
                }
                result.map_err(|e| e.to_string())
            })
        });
    }
    fn poll(&mut self) -> bool {
        let Some(result) = self.latest.take() else {
            return false;
        };
        self.busy = false;
        match result {
            Ok(Output::Export(message)) => self.status = message,
            Ok(Output::Page(page, spec, start, cursor)) => {
                self.status = format!(
                    "Showing {}–{} of {} matches. Earliest available timestamp: {} (memory), {} (disk).",
                    start,
                    start + page.queries.len(),
                    page.records_filtered,
                    page.earliest_timestamp,
                    page.earliest_timestamp_disk
                );
                self.preview = page
                    .queries
                    .iter()
                    .map(|q| {
                        format!(
                            "{}  {}  {}  {}",
                            q.time,
                            q.domain,
                            q.client.ip,
                            q.status.as_deref().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                self.last = Some((
                    *spec,
                    start + page.queries.len(),
                    cursor.or(page.cursor),
                    page.records_filtered,
                ));
            }
            Err(error) => self.status = error,
        }
        true
    }
}
fn view(s: &State, cx: &mut Cx<State>) -> El {
    let t = tok::theme(cx.system_dark());
    let feedback = if cx.system_reduced_motion() {
        rune::Transition::none()
    } else {
        rune::Transition::opacity().springs(rune::SpringPair::new(
            rune::Spring::new(0.14, 0.0),
            rune::Spring::new(0.10, 0.0),
        ))
    };
    let kit = Kit::from_palette(PaletteSeed {
        bg: t.bg,
        fg: t.text,
        accent: t.text,
    });
    let mut form = col().w_full().gap(10.0).child(
        text("† At least one")
            .font(type_::LABEL)
            .color(t.text_secondary),
    );
    for (i, label) in LABELS.iter().enumerate().take(15) {
        form = form.child(
            col()
                .w_full()
                .gap(3.0)
                .child(text(*label).font(type_::LABEL).color(t.text_secondary))
                .child(
                    text_input(&s.fields[i], type_::BODY)
                        .single_line()
                        .key(format!("field-{i}"))
                        .label(*label)
                        .w_full()
                        .h(36.0)
                        .px(10.0)
                        .fill(t.card)
                        .color(t.text)
                        .radius(6.0)
                        .on_edit(move |s: &mut State| {
                            s.sync_date_focus();
                            &mut s.fields[i]
                        }),
                ),
        );
    }
    let mut root = col()
        .w_full()
        .h_full()
        .padding(20.0)
        .gap(12.0)
        .fill(t.bg)
        .child(text("Pi-hole Export").font(type_::TITLE).color(t.text))
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new(format!("Auth: {}", AUTH[s.auth]))
                        .disabled(s.busy)
                        .on_press(|s: &mut State| s.auth = (s.auth + 1) % 3)
                        .build(&kit)
                        .key("auth"),
                )
                .child(
                    Button::new(format!("Format: {}", FORMATS[s.format]))
                        .disabled(s.busy)
                        .on_press(|s: &mut State| s.format = (s.format + 1) % 4)
                        .build(&kit)
                        .key("format"),
                )
                .child(
                    Button::new(if s.disk { "Disk: on" } else { "Disk: off" })
                        .disabled(s.busy)
                        .on_press(|s: &mut State| s.disk.toggle())
                        .build(&kit)
                        .key("disk"),
                ),
        )
        .child(form.grow(1.0).shrink().scroll(ScrollSpec {
            stick_bottom: false,
        }))
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Query")
                        .disabled(s.busy)
                        .on_press(|s: &mut State| s.start(Action::Query, false))
                        .build(&kit)
                        .key("query"),
                )
                .child(
                    Button::new("Next page")
                        .disabled(
                            s.busy || s.last.as_ref().is_none_or(|(_, n, _, total)| n >= total),
                        )
                        .on_press(|s: &mut State| s.start(Action::Next, false))
                        .build(&kit)
                        .key("next"),
                )
                .child(
                    Button::new("Export to file")
                        .disabled(s.busy)
                        .on_press(|s: &mut State| s.start(Action::Export, false))
                        .build(&kit)
                        .key("export"),
                )
                .child(
                    Button::new("Cancel")
                        .on_press(|s: &mut State| {
                            s.cancel.cancel();
                            s.pending = None;
                            s.status = "Cancelled. Any partially written file is retained.".into();
                        })
                        .build(&kit)
                        .key("cancel"),
                ),
        )
        .child(
            col().key("status").child(
                text(&s.status)
                    .key(format!("status-{}", s.status))
                    .transition(feedback)
                    .font(type_::BODY)
                    .color(t.text)
                    .w_full(),
            ),
        );
    if s.pending.is_some() {
        root = root.child(
            Button::new("Confirm heavy query")
                .on_press(|s: &mut State| {
                    if let Some(action) = s.pending.take() {
                        s.start(action, true);
                    }
                })
                .build(&kit)
                .key("confirm")
                .transition(feedback),
        );
    }
    root.child(
        col()
            .w_full()
            .h(130.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(
                text(&s.preview)
                    .key("results")
                    .transition(feedback)
                    .font(type_::BODY.mono())
                    .color(t.text)
                    .w_full(),
            ),
    )
}
fn main() {
    let mut spec = AppSpec::new("Pi-hole Export", (760.0, 900.0), State::default, view);
    spec.setup = Some(|s: &mut State, waker| s.latest.set_waker(waker));
    spec.poll = Some(|s: &mut State, _, _| {
        let focus = s.sync_date_focus();
        s.poll() || focus
    });
    rune::run(spec);
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};
    fn node<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if v["key"] == key {
            return Some(v);
        }
        v["children"]
            .as_array()?
            .iter()
            .find_map(|child| node(child, key))
    }
    #[test]
    fn accessible_controls_and_password_masking() {
        let mut state = State::default();
        state.fields[1] = TextEdit::new("synthetic-secret").secure();
        let mut rt = Runtime::new(state, view, (760.0, 900.0), Env::default());
        rt.frame(0.0);
        let tree = rt.accessibility_json();
        fn semantic(v: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
            if v["key"].is_string() {
                out.push(serde_json::json!({"key":v["key"],"role":v["role"],"name":v["name"],"states":v["states"]}));
            }
            if let Some(children) = v["children"].as_array() {
                for child in children {
                    semantic(child, out);
                }
            }
        }
        let mut nodes = Vec::new();
        semantic(&tree, &mut nodes);
        let snapshot = serde_json::to_string_pretty(&nodes).unwrap() + "\n";
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/accessibility.json");
        if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(&path, &snapshot).unwrap();
        }
        assert_eq!(snapshot, std::fs::read_to_string(path).unwrap());
        assert!(!tree.to_string().contains("synthetic-secret"));
        for (key, label) in [
            ("query", "Query"),
            ("export", "Export to file"),
            ("cancel", "Cancel"),
            ("next", "Next page"),
        ] {
            let control = node(&tree, key).expect("accessible action");
            assert_eq!(control["role"], "button");
            assert_eq!(control["name"], label);
        }
        assert_eq!(node(&tree, "field-0").unwrap()["name"], "Pi-hole URL");
    }
    #[test]
    fn clipboard_theme_motion_and_date_focus() {
        let mut rt = Runtime::new(State::default(), view, (760.0, 900.0), Env::default());
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        clipboard.set_text("synthetic-paste");
        rt.frame(0.0);
        assert!(rt.state.fields[1].text.is_empty());
        rt.update(|_, tx| tx.focus("field-1", true));
        rt.frame(0.0);
        rt.key(rune::KeyEvent {
            key: rune::Key::Command('v'),
            mods: rune::Mods {
                cmd: true,
                ..Default::default()
            },
        });
        rt.frame(0.0);
        rt.update(|_, _| {});
        rt.frame(0.0);
        assert!(rt.has_secure_focus());
        assert_eq!(rt.state.fields[1].text, "synthetic-paste");
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("synthetic-paste")
        );
        for dark in [false, true] {
            for reduced in [false, true] {
                rt.set_system_dark(dark);
                rt.set_system_reduced_motion(reduced);
                rt.update(|s, _| s.status = "Synthetic completion".into());
                rt.frame(0.016);
                rt.settle_all();
                assert_eq!(rt.system_reduced_motion(), reduced);
                assert!(rt.state.fields[1].focused);
                assert!(
                    !rt.accessibility_json()
                        .to_string()
                        .contains("synthetic-paste")
                );
            }
        }
        rt.update(|s, tx| {
            s.fields[3] = TextEdit::new("01/09/2026");
            tx.focus("field-3", true);
        });
        rt.frame(0.0);
        rt.update(|s, _| {
            s.sync_date_focus();
        });
        rt.frame(0.0);
        assert!(rt.state.fields[3].text.is_empty());
        rt.key(rune::KeyEvent {
            key: rune::Key::Text("02/09/2026".into()),
            mods: Default::default(),
        });
        rt.frame(0.0);
        rt.update(|s, _| {
            s.sync_date_focus();
        });
        rt.frame(0.0);
        assert_eq!(rt.state.fields[3].text, "02/09/2026");
        rt.update(|_, tx| tx.focus("field-4", true));
        rt.frame(0.0);
        rt.update(|_, tx| tx.focus("field-3", true));
        rt.frame(0.0);
        rt.update(|s, _| {
            s.sync_date_focus();
        });
        rt.frame(0.0);
        assert!(rt.state.fields[3].text.is_empty());
    }
    #[test]
    fn heavy_export_requires_confirmation_without_starting_worker() {
        let mut state = State::default();
        state.fields[3] = TextEdit::new("01/09/2026 00:00:00");
        state.fields[4] = TextEdit::new("04/09/2026 00:00:00");
        state.start(Action::Export, false);
        assert!(state.pending.is_some());
        assert!(!state.busy);
        let mut rt = Runtime::new(state, view, (760.0, 900.0), Env::default());
        rt.frame(0.0);
        assert_eq!(
            node(&rt.accessibility_json(), "confirm").unwrap()["name"],
            "Confirm heavy query"
        );
    }
    #[test]
    fn native_worker_queries_and_exports_small_loopback_fixture() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut requests = Vec::new();
            while requests.len() < 4 && Instant::now() < deadline {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = [0; 4096];
                let len = socket.read(&mut bytes).unwrap();
                let request = String::from_utf8_lossy(&bytes[..len]).to_string();
                let body = if request.starts_with("GET /api/auth ") {
                    serde_json::json!({"session":{"valid":true,"sid":null,"validity":1800,"totp":false,"message":null}})
                } else {
                    assert!(request.starts_with("GET /api/queries?"));
                    serde_json::json!({"queries":[{"id":1,"time":1788220801,"type":"A","domain":"synthetic.example","cname":null,"status":"FORWARDED","client":{"ip":"192.0.2.1","name":null},"dnssec":null,"reply":{"type":"IP","time":1},"list_id":null,"upstream":null,"ede":{"code":0,"text":null}}],"cursor":1,"recordsTotal":1,"recordsFiltered":1,"draw":0,"earliest_timestamp":1788220801,"earliest_timestamp_disk":1788220801})
                }.to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                requests.push(request);
            }
            requests
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("native export.csv");
        let mut state = State::default();
        state.auth = 2;
        state.fields[0] = TextEdit::new(format!("http://{address}"));
        state.fields[3] = TextEdit::new("01/09/2026 00:00:00");
        state.fields[4] = TextEdit::new("02/09/2026 00:00:00");
        state.fields[14] = TextEdit::new(path.to_str().unwrap());
        for action in [Action::Query, Action::Export] {
            state.start(action, false);
            let deadline = Instant::now() + Duration::from_secs(8);
            while state.busy && Instant::now() < deadline {
                state.poll();
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(!state.busy, "native job did not finish");
            match action {
                Action::Query => assert!(
                    state.preview.contains("synthetic.example"),
                    "{}",
                    state.status
                ),
                _ => assert!(
                    state.status.starts_with("Exported 1 rows"),
                    "{}",
                    state.status
                ),
            }
        }
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("synthetic.example")
        );
        assert_eq!(server.join().unwrap().len(), 4);
    }
}
