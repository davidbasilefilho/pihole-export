"""Linux X11 native clipboard + actual GUI asset, synthetic auth only."""
import json, os, subprocess, sys, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
accepted=threading.Event()
secret='synthetic-paste-only'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def reply(self,data):
  raw=json.dumps(data).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path=='/api/auth' and data.get('password')==secret: accepted.set()
  self.reply({'session':dict(valid=True,sid=None,csrf=None,validity=1800,totp=False,message=None)})
 def do_GET(self):
  self.reply(dict(queries=[],cursor=0,recordsTotal=0,recordsFiltered=0,draw=0,earliest_timestamp=0,earliest_timestamp_disk=0))
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
def x(*args): return subprocess.check_output(['xdotool',*args],text=True)
def key(*args): x('key','--clearmodifiers',*args); time.sleep(.1)
def type_text(value): x('type','--clearmodifiers','--delay','2',value)
with tempfile.TemporaryDirectory() as directory:
 asset=next(Path('dist').glob('*-gui-*-linux-x64')).resolve()
 process=subprocess.Popen([str(asset),'--native'],cwd=directory,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  window=''
  for _ in range(100):
   result=subprocess.run(['xdotool','search','--name','^Pi-hole Export$'],capture_output=True,text=True)
   if result.returncode==0: window=result.stdout.splitlines()[-1]; break
   time.sleep(.1)
  assert window, 'Native GUI window did not appear'
  x('windowfocus',window); time.sleep(.3)
  tree=json.loads(Path('artifacts/package-smoke/startup.json').read_text())['accessibility']
  def find(node,name):
   if node.get('name')==name and node.get('role')=='textInput': return node
   for child in node.get('children',[]):
    hit=find(child,name)
    if hit:return hit
  # Use the actual startup accessibility bounds, independent of native titlebar size.
  def field(node):
   if node.get('name')=='Pi-hole URL' and 'bounds' in node and node.get('role')!='label': return node
   for child in node.get('children',[]):
    hit=field(child)
    if hit:return hit
  bounds=field(tree)['bounds']; x('mousemove','--window',window,str(int(bounds[0]+20)),str(int(bounds[1]+bounds[3]/2)));x('click','1')
  key('ctrl+a');type_text(f'http://127.0.0.1:{server.server_port}');key('Tab')
  subprocess.run(['xclip','-selection','clipboard'],input=secret.encode(),check=True)
  key('ctrl+v');key('Tab','Tab');type_text('01/09/2026');key('Tab');type_text('02/09/2026');key('Tab','Tab');type_text('synthetic.example')
  def by_key(node, wanted):
   if node.get('key') == wanted: return node
   for child in node.get('children', []):
    hit=by_key(child,wanted)
    if hit:return hit
  bounds=by_key(tree,'query')['bounds']
  x('mousemove','--window',window,str(int(bounds[0]+bounds[2]/2)),str(int(bounds[1]+bounds[3]/2)))
  x('click','1')
  assert accepted.wait(10), 'GUI did not authenticate with exactly one pasted synthetic password'
  print('PASS native GUI Ctrl+V via OS clipboard and date-only query')
 finally:
  process.terminate()
  try: process.wait(timeout=5)
  except subprocess.TimeoutExpired: process.kill();process.wait()
  server.shutdown()
