"""Compiled TUI smoke test. Requires Python pexpect and pyte; never contacts Pi-hole."""
import csv
import json
import os
from pathlib import Path
import sys
import socket
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pexpect
import pyte

binary = Path(sys.argv[1] if len(sys.argv) > 1 else "bin/pihole-export").resolve()
requests = []
query_started = threading.Event()
release_query = threading.Event()
slow = False
mode = "rows"
pasted = []
row = {
    "id": 1, "time": 1788220801, "type": "A", "domain": "synthetic.example",
    "cname": None, "status": "FORWARDED", "client": {"ip": "192.0.2.1", "name": None},
    "dnssec": None, "reply": {"type": "IP", "time": 1.5}, "list_id": None,
    "upstream": None, "ede": {"code": 0, "text": None},
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert body.get('password') == 'synthetic-paste-only'
        pasted.append(True)
        self.do_GET()

    def do_GET(self):
        requests.append(self.path)
        path = urlsplit(self.path).path
        if path == "/api/auth":
            data = {"session": {"valid": True, "sid": None, "csrf": None,
                                "validity": 1800, "totp": False, "message": None}}
        elif path == "/api/queries/suggestions":
            data = {"suggestions": {key: [] for key in ["domain", "client_ip", "client_name",
                    "upstream", "type", "status", "reply", "dnssec"]}}
        elif path == "/api/queries":
            query_started.set()
            if slow:
                release_query.wait(10)
            data = {"queries": [row], "cursor": 1, "recordsTotal": 1, "recordsFiltered": 1,
                    "draw": 0, "earliest_timestamp": row["time"], "earliest_timestamp_disk": row["time"]}
        else:
            self.send_error(404)
            return
        status = 200
        if path == "/api/queries":
            start = int(parse_qs(urlsplit(self.path).query).get('start', ['0'])[0])
            if mode == "lost" or (mode == "lost_after_page" and start > 0):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if mode == "lost_after_page":
                data.update(queries=[dict(row, id=i) for i in range(10000)], recordsTotal=10001, recordsFiltered=10001)

            if mode == "empty":
                data.update(queries=[], recordsTotal=0, recordsFiltered=0)
            elif mode == "error":
                status = 504
                data = {"error": {"key": "api_error", "message": "do-not-display-secret"}}
        raw = json.dumps(data).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass  # expected when cancelling the in-flight request


def query_requests():
    return [url for url in requests if urlsplit(url).path == "/api/queries"]


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="pihole-pty-") as directory, tempfile.TemporaryDirectory(prefix="pihole-logs-") as log_home:
        child = pexpect.spawn(str(binary), cwd=directory, encoding="utf-8", timeout=1,
                              dimensions=(40, 140), env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "XDG_STATE_HOME": log_home, "HOME": log_home})
        screen = pyte.Screen(140, 40)
        stream = pyte.Stream(screen)

        def pump(seconds=0.2):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                try:
                    stream.feed(child.read_nonblocking(65536, timeout=0.05))
                except pexpect.TIMEOUT:
                    pass
                except pexpect.EOF:
                    break
            return "\n".join(screen.display)

        def wait_for(text):
            until = time.monotonic() + 5
            while time.monotonic() < until:
                if text in pump():
                    return
            raise AssertionError(f"Missing {text!r}:\n" + "\n".join(screen.display))

        def send(keys):
            child.send(keys)
            pump()

        def fill(value):
            send("\x01\x0b" + value)  # Home, kill to end, type into the actual terminal

        try:
            wait_for("CONNECTION")
            send(f"http://127.0.0.1:{server.server_port}")
            send("\t\t\t")  # host -> port -> auth -> password
            send("\x1b[200~synthetic-paste-only\x1b[201~")
            assert "synthetic-paste-only" not in pump()
            send("\t\t\r")  # totp -> connect
            assert pasted == [True]
            wait_for("EXPORT TO FILE")
            assert not query_requests()
            fill("01/09/2026")
            send("\t")
            fill("02/09/2026")  # one-day synthetic interval
            send("\t")
            fill("UTC")
            send("\t" * 9 + "\r")  # enable on-disk history
            send("\t" * 3 + "\r")  # Export to File, without Fetch Queries
            wait_for("STREAM ALL MATCHING ROWS")
            assert not query_requests()
            send("\x1b")  # cancel destination
            wait_for("EXPORT TO FILE")
            assert not query_requests() and not list(Path(directory).iterdir())
            send("\r")
            wait_for("STREAM ALL MATCHING ROWS")
            assert not query_requests() and not list(Path(directory).iterdir()), "Enter must not start export"
            send("\x1b")  # cancel destination dialog before writing
            wait_for("EXPORT TO FILE")
            assert not query_requests()
            send("\r")
            wait_for("STREAM ALL MATCHING ROWS")
            destination = Path(directory) / "alternate path" / "chosen export.csv"
            destination.parent.mkdir()
            fill(str(destination))
            send("\r")
            wait_for("Exported 1 rows")
            assert len(query_requests()) == 1, "Direct export must make exactly one scan"
            with destination.open() as handle:
                records = list(csv.DictReader(handle))
            assert len(records) == 1 and records[0]["domain"] == "synthetic.example"
            params = parse_qs(urlsplit(query_requests()[0]).query)
            assert params["disk"] == ["true"] and params["from"] == ["1788220800"]
            assert params["until"] == ["1788307200"] and params["length"] == ["10000"]
            wait_for("EXPORT TO FILE")

            # Cancel an HTTP request after the writer has created the CSV header.
            slow = True
            query_started.clear()
            send("\r")
            wait_for("STREAM ALL MATCHING ROWS")
            cancelled = Path(directory) / "cancelled.csv"
            fill(str(cancelled))
            send("\r")
            assert query_started.wait(3)
            wait_for("EXPORTING")
            send("\x1b")
            wait_for("Export cancelled")
            wait_for("EXPORT TO FILE")
            assert not cancelled.exists()
            cancelled_partial = next(Path(directory).glob(".cancelled.csv.*.partial"))
            before = cancelled_partial.read_bytes()
            assert b"timestamp" in before and b"synthetic.example" not in before
            release_query.set()
            pump(0.5)
            assert cancelled_partial.read_bytes() == before, "Cancelled writer must not append late rows"
            assert len(query_requests()) == 2
            assert destination.exists()
            slow = False
            for case in ["error", "empty", "lost", "lost_after_page"]:
                mode = case
                send("\r")
                wait_for("STREAM ALL MATCHING ROWS")
                target = Path(directory) / f"{case}.csv"
                fill(str(target))
                target.write_text("previous completed file")
                previous_requests = len(query_requests())
                send("\r")
                if case != "empty":
                    wait_for("timed out (HTTP 504)" if case == "error" else "Network request failed (not retried)")
                    if case.startswith("lost"):
                        assert len(query_requests()) - previous_requests == (2 if case == "lost_after_page" else 1), "Retries must remain bounded and sequential"
                    wait_for("Destination unchanged")
                    assert "STREAM ALL MATCHING ROWS" in pump()
                    assert "do-not-display-secret" not in pump()
                    assert "Logs:" in pump()
                    send("\x1b")
                    wait_for("EXPORT TO FILE")
                else:
                    wait_for("Exported 0 rows")
                    assert "STREAM ALL MATCHING ROWS" not in pump()
                if case != "empty":
                    assert target.read_text() == "previous completed file"
                    partial = next(Path(directory).glob(f".{case}.csv.*.partial"))
                    with partial.open() as handle:
                        assert len(list(csv.DictReader(handle))) == (10000 if case == "lost_after_page" else 0)
                else:
                    with target.open() as handle: assert len(list(csv.DictReader(handle))) == 0
            logs = [json.loads(line) for path in Path(log_home).rglob("operation-*.jsonl") for line in path.read_text().splitlines()]
            assert any(v["outcome"] == "error" and v["cause"] == "api_timeout" and v["pages"] == 0 for v in logs)
            assert any(v["outcome"] == "zero_results" and v["pages"] == 1 for v in logs)
            assert "do-not-display-secret" not in json.dumps(logs)
            assert any(v["outcome"] == "error" and v["cause"] == "network_failure" and v["rows"] == 0 for v in logs)
            assert any(v["outcome"] == "error" and v["cause"] == "network_failure" and v["rows"] == 10000 and v["pages"] == 1 for v in logs)
            print("PASS: PTY direct export, both pre-write cancellations, "
                  "absolute destination with spaces, single-row readback, in-flight cancellation; "
                  "first-batch HTTP timeout displayed in dialog, empty success and persistent diagnostics.")
        finally:
            release_query.set()
            child.send("\x03")
            pump()
            child.close(force=True)
finally:
    release_query.set()
    server.shutdown()
    server.server_close()
