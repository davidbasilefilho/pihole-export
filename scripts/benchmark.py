"""Repeatable full-operation benchmark: synthetic rows, one day, loopback only."""
import json, os, statistics, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from pathlib import Path
rows = [dict(id=i,time=1788220800+i,type='A',domain='synthetic.example',cname=None,status='FORWARDED',client=dict(ip='192.0.2.1',name=None),dnssec=None,reply=dict(type='IP',time=1.5),list_id=None,upstream=None,ede=dict(code=0,text=None)) for i in range(20000)]
lock=threading.Lock()
metrics={}
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args): pass
 def do_GET(self):
  with lock:
   metrics['requests']+=1; metrics['active']+=1; metrics['peak']=max(metrics['peak'],metrics['active']); metrics['connections'].add(self.client_address)
  q=parse_qs(urlsplit(self.path).query); start=int(q['start'][0]); length=int(q['length'][0])
  body=json.dumps(dict(queries=rows[start:start+length],cursor=1,recordsTotal=len(rows),recordsFiltered=len(rows),draw=0,earliest_timestamp=1788220800,earliest_timestamp_disk=1788220800),separators=(',',':')).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); self.wfile.flush()
  with lock: metrics['bytes']+=len(body); metrics['active']-=1
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
try:
 with tempfile.TemporaryDirectory() as directory:
  for mode in ['query','export']:
   for run in range(5):
    metrics.update(requests=0,active=0,peak=0,connections=set(),bytes=0)
    dest=Path(directory)/'out.jsonl'
    raw=subprocess.check_output(['bun','scripts/benchmark.ts',f'http://127.0.0.1:{server.server_port}',mode,str(dest)],text=True)
    result=json.loads(raw); assert result['count']==len(rows)
    result.update(run=run,requests=metrics['requests'],response_bytes=metrics['bytes'],peak_requests=metrics['peak'],connections=len(metrics['connections']))
    if mode=='export':
     assert sum(1 for _ in dest.open())==len(rows)
     result['file_bytes']=dest.stat().st_size
    results.append(result)
 print(json.dumps({'runs':results,'median_ms':{mode:statistics.median(r['milliseconds'] for r in results if r['mode']==mode) for mode in ['query','export']}},indent=2))
finally: server.shutdown()
