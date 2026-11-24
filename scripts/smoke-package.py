"""Exercise extracted release files with one synthetic query on loopback."""
import csv
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

row = dict(id=1, time=1788220801, type='A', domain='synthetic.example', cname=None,
           status='FORWARDED', client=dict(ip='192.0.2.1', name=None), dnssec=None,
           reply=dict(type='IP', time=1.5), list_id=None, upstream=None, ede=dict(code=0,text=None))
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.startswith('/api/auth'):
            data = {'session': dict(valid=True,sid=None,csrf=None,validity=1800,totp=False,message=None)}
        elif self.path.startswith('/api/queries'):
            data = dict(queries=[row],cursor=1,recordsTotal=1,recordsFiltered=1,draw=0,
                        earliest_timestamp=row['time'],earliest_timestamp_disk=row['time'])
        else:
            self.send_error(404); return
        raw = json.dumps(data).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)

server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
evidence = Path('artifacts/package-smoke').resolve()
evidence.mkdir(parents=True,exist_ok=True)
try:
    with tempfile.TemporaryDirectory(prefix='pihole package ') as directory:
        for asset in sorted(Path('dist').glob('pihole-export-*'), key=lambda p: '-gui-' in p.name):
            stage = Path(directory) / asset.stem
            stage.mkdir()
            binary = stage / asset.name
            shutil.copy2(asset, binary)
            ext = '.exe' if os.name == 'nt' else ''
            env = {k:v for k,v in os.environ.items() if not k.startswith('PIHOLE_')}
            if '-tui-' in asset.name:
                for fmt in ['csv','jsonl','sqlite','parquet']:
                    dest = stage / ('synthetic.'+fmt)
                    cmd = [str(binary),'--headless','--host',f'http://127.0.0.1:{server.server_port}',
                           '--auth','none','--from','2026-09-01 00:00:00','--until','2026-09-01 01:00:00',
                           '--timezone','UTC','--format',fmt,'--output',str(dest)]
                    subprocess.run(cmd,cwd=directory,env=env,check=True,timeout=30)
                    assert dest.stat().st_size > 0
                    if fmt == 'jsonl': assert json.loads(dest.read_text())['domain']=='synthetic.example'
                    if fmt == 'csv': assert len(list(csv.DictReader(dest.open())))==1
                    if fmt == 'parquet': assert dest.read_bytes()[:4]==dest.read_bytes()[-4:]==b'PAR1'
                    if fmt == 'sqlite':
                        with sqlite3.connect(dest) as db:
                            table=db.execute("select name from sqlite_master where type='table'").fetchone()[0]
                            assert db.execute('select count(*) from "'+table+'"').fetchone()[0]==1
            else:
                subprocess.run([str(binary),'--snap',str(evidence/'startup.png'),'--tree',str(evidence/'startup.json'),'--settle'],cwd=directory,env=env,check=True,timeout=90)
                subprocess.run([str(binary),'--native','--trace',str(evidence/'native.jsonl'),'--frames','60'],cwd=directory,env=env,check=True,timeout=90)
                assert (evidence/'startup.png').stat().st_size > 100
                assert 'header' in (evidence/'native.jsonl').read_text()
            print('PASS extracted',asset.name,flush=True)
finally:
    server.shutdown()
