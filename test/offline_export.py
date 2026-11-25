"""Synthetic, local-only CLI validation/benchmark. Never generates a real backup."""
import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import signal
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
from contextlib import closing

BASE = 1788220800

def fixture(root, rows):
    source = root / ('snapshot with spaces #%.db' if os.name == 'nt' else 'snapshot with spaces #?%.db')
    with closing(sqlite3.connect(source)) as db:
        db.executescript('''
CREATE TABLE ftl(id INTEGER PRIMARY KEY,value BLOB); INSERT INTO ftl VALUES(0,22);
CREATE TABLE query_storage(id INTEGER PRIMARY KEY,timestamp INTEGER,type INTEGER,status INTEGER,domain INTEGER,client INTEGER,forward INTEGER,additional_info INTEGER,reply_type INTEGER,reply_time REAL,dnssec INTEGER,list_id INTEGER,ede INTEGER);
CREATE TABLE domain_by_id(id INTEGER PRIMARY KEY,domain TEXT); INSERT INTO domain_by_id VALUES(1,'synthetic.example');
CREATE TABLE client_by_id(id INTEGER PRIMARY KEY,ip TEXT,name TEXT); INSERT INTO client_by_id VALUES(1,'192.0.2.1','synthetic-client');
CREATE TABLE forward_by_id(id INTEGER PRIMARY KEY,forward TEXT); INSERT INTO forward_by_id VALUES(1,'192.0.2.53#53');
CREATE TABLE addinfo_by_id(id INTEGER PRIMARY KEY,type INTEGER,content); INSERT INTO addinfo_by_id VALUES(1,1,'synthetic-cname.example');
''')
        db.executemany('INSERT INTO query_storage VALUES(?,?,1,9,1,1,1,1,4,1.23456789,1,42,15)',
                       ((i, BASE + i * 0.125) for i in range(1, rows + 1)))
        db.commit()
    coverage = root / 'coverage.json'
    coverage.write_text(json.dumps({'version': 1, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'from': BASE, 'until': BASE + 3 * 86400, 'consistent_backup': True, 'complete_history': True, 'api_policy': {'privacy_level': 0, 'exclude_domains': [], 'exclude_clients': []}}))
    return source, coverage

def run(command, rows, trace):
    with tempfile.TemporaryDirectory(prefix='pihole-offline-test-') as temp:
        root = Path(temp)
        if len(command) == 1:
            asset = root / 'pihole-export'
            shutil.copy2(Path(command[0]).resolve(), asset)
            command = [str(asset)]
        source, coverage = fixture(root, rows)
        original = hashlib.sha256(source.read_bytes()).hexdigest()
        env = dict(os.environ, XDG_STATE_HOME=str(root / 'state'),
                   HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1',
                   PIHOLE_PASSWORD='synthetic-never-read-password')
        args = ['--offline', str(source), '--coverage', str(coverage), '--isolated-backup',
                '--from', '2026-09-01', '--until', '2026-09-04', '--timezone', 'UTC']
        measurements = []
        for fmt in ['csv', 'jsonl', 'sqlite', 'parquet']:
            destination = root / ('output with spaces.' + fmt)
            destination.write_text('previous-completed-result')
            argv = [*command, *args, '--format', fmt, '--output', str(destination)]
            if trace:
                # Fail any socket creation, while recording even attempted calls.
                argv = ['strace', '-f', '-qq', '-yy', '-e', 'trace=network', '-e', 'inject=socket:error=EPERM', '-o', str(root / 'network.trace'), *argv]
            started = time.monotonic()
            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                child = subprocess.Popen(argv, env=env, cwd=root, stdout=stdout, stderr=stderr)
                while True:
                    waited, status, usage = os.wait4(child.pid, os.WNOHANG)
                    if waited: break
                    if time.monotonic() - started > 60:
                        child.kill(); raise TimeoutError("Synthetic offline export exceeded 60 seconds")
                    time.sleep(.005)
                child.returncode = os.waitstatus_to_exitcode(status)
                stdout.seek(0); stderr.seek(0)
                assert child.returncode == 0, stderr.read().decode()
                result = json.loads(stdout.read())
            elapsed = time.monotonic() - started
            assert result['count'] == rows and result['source'] == 'offline_snapshot', result
            assert hashlib.sha256(source.read_bytes()).hexdigest() == original
            if trace:
                calls = (root / 'network.trace').read_text()
                assert 'AF_INET' not in calls and not re.search(r'\bsocket\(', calls) and 'connect(' not in calls, calls
                # Bun's stdin/stdout pipes are anonymous AF_UNIX socketpairs.
                # Permit only those IPC descriptors, never an Internet socket.
                for line in calls.splitlines():
                    if re.search(r'\b(sendto|recvfrom|sendmsg|recvmsg)\(', line):
                        assert 'UNIX-STREAM' in line, line
            if fmt == 'csv':
                with destination.open(newline='') as stream:
                    count = 0
                    for row in csv.DictReader(stream):
                        assert int(row['query_id']) == rows - count
                        count += 1
                assert count == rows
            elif fmt == 'jsonl':
                count = 0
                with destination.open() as stream:
                    for line in stream:
                        row = json.loads(line)
                        assert row['query_id'] == rows - count
                        assert row['timestamp'] == BASE + (rows - count) * .125
                        assert row['reply_time_ms'] == 1.23456789 and row['ede_text'] == 'blocked'
                        count += 1
                assert count == rows
            elif fmt == 'sqlite':
                with closing(sqlite3.connect(destination)) as db:
                    assert db.execute('SELECT count(*) FROM queries').fetchone()[0] == rows
            else:
                data = destination.read_bytes()
                assert data[:4] == data[-4:] == b'PAR1'
            measurements.append({'format': fmt, 'rows': rows, 'elapsedSeconds': elapsed,
                'rowsPerSecond': round(rows / elapsed), 'outputBytes': destination.stat().st_size,
                'maxProcessRssKiB': usage.ru_maxrss, 'userSeconds': usage.ru_utime, 'systemSeconds': usage.ru_stime,
                'fsInputBlocks': usage.ru_inblock, 'fsOutputBlocks': usage.ru_oublock, 'core': result['metrics']})
        if rows == 100000:
            destination = root / "cancelled.jsonl"
            destination.write_text("previous")
            child = subprocess.Popen([*command, *args, "--format", "jsonl", "--output", str(destination)],
                env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                partials = list(root.glob(".cancelled.jsonl.*.partial"))
                if partials and partials[0].stat().st_size > 32768:
                    child.send_signal(signal.SIGINT)
                    break
                assert child.poll() is None, "Export completed before cancellation could be exercised"
                time.sleep(.001)
            else:
                child.kill(); raise AssertionError("No partial batch observed")
            stdout, stderr = child.communicate(timeout=10)
            assert child.returncode != 0 and destination.read_text() == "previous", (stdout, stderr)
            log_text = "\n".join(p.read_text() for p in (root / "state/pihole-export/logs").glob("*.jsonl"))
            assert '"outcome":"cancelled"' in log_text, log_text
        # Zero results and refusals go through the actual CLI, preserving old output.
        output = root / 'last.jsonl'
        base = [*command, *args, '--format', 'jsonl', '--output', str(output)]
        zero = subprocess.run([*base, '--domain', 'absent.example'], env=env, capture_output=True, text=True, timeout=60)
        assert zero.returncode == 0 and json.loads(zero.stdout)['count'] == 0, zero.stderr
        output.write_text('previous')
        for extra in [['--host', 'never-connect.invalid'], ['--coverage', 'missing']]:
            failed = subprocess.run([*base, *extra], env=env, capture_output=True, text=True, timeout=60)
            assert failed.returncode != 0 and output.read_text() == 'previous'
        blocker = root / 'log-location-is-a-file'
        blocker.write_text('sentinel')
        unlogged = subprocess.run(base, env={**env, 'XDG_STATE_HOME': str(blocker)}, capture_output=True, text=True, timeout=60)
        assert unlogged.returncode == 0 and json.loads(unlogged.stdout)['count'] == rows, unlogged.stderr
        assert blocker.read_text() == 'sentinel'
        output.write_text('previous')
        bad_coverage = json.loads(coverage.read_text()); bad_coverage['sha256'] = '0' * 64
        coverage.write_text(json.dumps(bad_coverage))
        failed = subprocess.run(base, env=env, capture_output=True, text=True, timeout=60)
        assert failed.returncode != 0 and 'SHA-256' in failed.stderr and output.read_text() == 'previous'
        logs = '\n'.join(path.read_text() for path in (root / 'state/pihole-export/logs').glob('*.jsonl'))
        assert 'zero_results' in logs and '"outcome":"error"' in logs
        for private in ['synthetic.example', '192.0.2.1', 'synthetic-never-read-password', str(source), str(output)]:
            assert private not in logs
        print(json.dumps({'networkTrace': trace, 'measurements': measurements}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rows', type=int, choices=[20, 20000, 100000], default=20)
    parser.add_argument('--trace', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    run(options.command, options.rows, options.trace)
