"""Standalone Windows entry points, local synthetic snapshot only; never acquires a backup."""
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing, contextmanager, ExitStack
import uuid
from offline_export import fixture

assert os.name == 'nt'
tui_source = Path(sys.argv[1]).resolve()
gui_source = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
evidence = Path('artifacts/package-smoke/windows-offline').resolve()
evidence.mkdir(parents=True, exist_ok=True)

def validate(path, fmt, rows=20):
    if fmt == 'csv':
        with path.open(newline='') as stream:
            data = list(csv.DictReader(stream))
        assert len(data) == rows
        assert [int(row['query_id']) for row in data] == list(range(rows, 0, -1))
    elif fmt == 'jsonl':
        data = [json.loads(line) for line in path.read_text().splitlines()]
        assert [row['query_id'] for row in data] == list(range(rows, 0, -1))
        assert data[0]['timestamp'] == 1788220800 + rows * .125
    elif fmt == 'sqlite':
        with closing(sqlite3.connect(path)) as db:
            table = db.execute("select name from sqlite_master where type='table'").fetchone()[0]
            assert db.execute('select count(*) from "'+table+'"').fetchone()[0] == rows
    else:
        assert path.read_bytes()[:4] == path.read_bytes()[-4:] == b'PAR1'

@contextmanager
def deny_worker_network(programs):
    # Block the Rust worker (the TUI EXE itself) and GUI, without changing global firewall policy.
    # This proves no outbound dependency, not that a blocked call was never attempted.
    names = []
    def ps(command):
        result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + command], capture_output=True, text=True, timeout=30)
        if result.returncode: raise RuntimeError('Windows test firewall setup failed: '+result.stderr)
    try:
        ps("if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count -ne 0) { throw 'Offline smoke requires enabled Windows firewall profiles' }")
        for program in programs:
            name = 'pihole-offline-test-' + uuid.uuid4().hex
            quoted = str(program).replace("'", "''")
            ps(f"New-NetFirewallRule -DisplayName '{name}' -Direction Outbound -Program '{quoted}' -Action Block -Profile Any | Out-Null")
            names.append(name)
        yield
    finally:
        for name in names:
            ps(f"Remove-NetFirewallRule -DisplayName '{name}'")

with tempfile.TemporaryDirectory(prefix='pihole offline ') as temporary, ExitStack() as resources:
    root = Path(temporary)
    tui = root / 'tui.exe'
    shutil.copy2(tui_source, tui)
    gui = root / 'gui.exe'
    if gui_source: shutil.copy2(gui_source, gui)
    resources.enter_context(deny_worker_network([tui, gui] if gui_source else [tui]))
    snapshot, coverage = fixture(root, 20)
    original = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    env = dict(os.environ, LOCALAPPDATA=str(root / 'state'), TEMP=str(root), TMP=str(root),
               HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1',
               PIHOLE_PASSWORD='synthetic-never-use',
               BUN_TMPDIR=r'\\localhost\never-open\temp', OPENTUI_LIB_PATH=r'\\localhost\never-open\addon.dll')
    args = ['--offline', str(snapshot), '--coverage', str(coverage), '--isolated-backup',
            '--from', '2026-09-01', '--until', '2026-09-04', '--timezone', 'UTC']
    timings = {}
    for fmt in ['csv', 'jsonl', 'sqlite', 'parquet']:
        output = root / ('headless.' + fmt)
        output.write_text('previous')
        started = time.monotonic()
        result = subprocess.run([str(tui), *args, '--format', fmt, '--output', str(output)],
                                cwd=root, env=env, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        report = json.loads(result.stdout)
        assert report['count'] == 20 and report['metrics']['networkRequests'] == 0, report
        validate(output, fmt)
        timings[fmt] = time.monotonic() - started
    # Reject a local junction too: do not follow reparse points even when its target is local.
    junction = root / 'alias'
    subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(root)], check=True, capture_output=True)
    bad = args.copy(); bad[1] = str(junction / snapshot.name)
    result = subprocess.run([str(tui), *bad, '--output', str(root/'junction.csv')], cwd=root, env=env, capture_output=True, timeout=20)
    assert result.returncode != 0 and not (root/'junction.csv').exists()
    junction.rmdir()
    output = root / 'preserve.csv' 
    output.write_text('previous')
    for invalid in [str(root/'missing.db'), r'\\localhost\never-open\snapshot.db', str(snapshot)+':stream', str(root/'..'/'snapshot.db')]:
        bad = args.copy(); bad[1] = invalid
        result = subprocess.run([str(tui), *bad, '--output', str(output)], cwd=root, env=env,
                                capture_output=True, text=True, timeout=20)
        assert result.returncode != 0 and output.read_text() == 'previous'
    original_metadata = coverage.read_text()
    for change in [{'api_policy': {'privacy_level':0,'exclude_domains':['private.*'],'exclude_clients':[]}}, {'until':1788220801}]:
        value = json.loads(original_metadata); value.update(change); coverage.write_text(json.dumps(value))
        result = subprocess.run([str(tui), *args, '--output', str(output)], cwd=root, env=env, capture_output=True, timeout=20)
        assert result.returncode != 0 and output.read_text() == 'previous'
    coverage.write_text(original_metadata)
    result = subprocess.run([str(tui), *args, '--domain', 'absent.invalid', '--output', str(output)], cwd=root, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0 and json.loads(result.stdout)['count'] == 0
    logs = '\n'.join(p.read_text() for p in (root/'state/pihole-export/logs').glob('*.jsonl'))
    assert 'offline_export' in logs and 'zero_results' in logs, logs
    for forbidden in ['synthetic-never-use', 'private.*', str(snapshot), 'synthetic.example']:
        assert forbidden not in logs

    # Actual terminal input through Windows ConPTY, not a component mock.
    from winpty import PtyProcess, Backend
    import pyte
    child = PtyProcess.spawn([str(tui)], cwd=str(root), env=env, dimensions=(70, 150), backend=str(Backend.ConPTY))
    screen = pyte.Screen(150, 70); stream = pyte.Stream(screen)
    import threading
    stopped = threading.Event()
    def read_terminal():
        while not stopped.is_set():
            try: stream.feed(child.read(4096))
            except (EOFError, OSError): break
    reader = threading.Thread(target=read_terminal, daemon=True); reader.start()
    def expect(message):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if message in '\n'.join(screen.display): return
            time.sleep(.05)
        raise AssertionError(message+'\n'+'\n'.join(screen.display))
    def send(value):
        child.write(value); time.sleep(.15)
    try:
        expect('CONNECT'); send('\x0f'); expect('OFFLINE SNAPSHOT')
        values = [str(snapshot), str(coverage), '2026-09-01', '2026-09-04', 'UTC', '', '', '', '', '', '', '', '', str(root/'interactive.csv')]
        for value in values:
            send('\x01\x0b'); send(value); send('\t')
        send('\r'); send('\t'); send('\t'); send('\r')
        expect('CONFIRM OFFLINE EXPORT'); send('\x1b')
        assert not (root/'interactive.csv').exists()
        send('\r'); expect('CONFIRM OFFLINE EXPORT'); send('\r'); expect('Completed offline export: 20 rows')
        validate(root/'interactive.csv', 'csv')
        for fmt in ['jsonl', 'sqlite', 'parquet']:
            send('\x1b[Z'); send('\r'); send('\t'); send('\r'); expect('CONFIRM OFFLINE EXPORT')
            send('\r'); expect('Completed offline export: 20 rows'); validate(root/'interactive.csv', fmt)

        previous = (root/'interactive.csv').read_bytes()
        send('\t\t\t'); send('\x01\x0b'+str(root/'missing.db')); send('\x1b[Z' * 3)
        send('\r'); expect('CONFIRM OFFLINE EXPORT'); send('\r'); expect('A regular local SQLite snapshot is required')
        assert (root/'interactive.csv').read_bytes() == previous
        (evidence/'tui.txt').write_text('\n'.join(screen.display), encoding='utf-8')
    finally:
        # Leave through the app so the native launcher reaps its child and removes its payload.
        try:
            send('\t\t\r'); send('\x1b')
            deadline = time.monotonic() + 10
            while child.isalive() and time.monotonic() < deadline: time.sleep(.05)
        finally:
            stopped.set()
            if child.isalive():
                subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'], capture_output=True)
                child.terminate(force=True)


    if gui_source:
        # Rune's supported window-script drives a real window at the framework input boundary.
        # It is not OS keyboard injection or proof of hardware rendering on the user's machine.
        events = [{'t':.2,'key':'mode'}, {'t':.5,'key':'field-3'}]
        t = .8
        values = ['2026-09-01','2026-09-04','UTC','','','','','','','','',str(root/'gui.csv'),str(snapshot),str(coverage)]
        for value in values:
            events += [{'t':t,'type':'key','name':'a','cmd':True}, {'t':t+.05,'paste':value}, {'t':t+.1,'type':'key','name':'tab'}]
            t += .25
        events += [{'t':t,'key':'disk'}, {'t':t+.3,'key':'export'}, {'t':t+.6,'key':'confirm'}, {'t':t+5,'type':'mark','name':'offline-complete'}]
        script = root/'input.json'; script.write_text(json.dumps(events))
        with (evidence/'gui-script.txt').open('w') as log:
            process = subprocess.Popen([str(gui),'--native','--window-script',str(script),'--trace',str(evidence/'gui-native.jsonl')],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic()+45
                while time.monotonic()<deadline and not (root/'gui.csv').exists() and process.poll() is None: time.sleep(.1)
                validate(root/'gui.csv','csv')
            finally:
                process.terminate(); process.wait(timeout=10)
        assert 'rune-script-error' not in (evidence/'gui-script.txt').read_text()
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == original
    (evidence/'summary.json').write_text(json.dumps({'headless_seconds':timings,'rows':20,'tui':'ConPTY','gui':bool(gui_source)},indent=2))
    print('PASS Windows standalone offline headless formats, refusals, logs and interactive workflows')
