import os, pathlib, subprocess, time, signal, urllib.request, json, base64, fcntl, socket
ROOT=pathlib.Path('/Users/stalindelcasttillo/opencode-mobile-fixed')
STATE=pathlib.Path('/Users/stalindelcasttillo/.local/state/opencode-mobile-remote')
CONFIG=pathlib.Path('/Users/stalindelcasttillo/.config/opencode')
REMOTE='https://opencode-remote-stalin.pages.dev'
os.umask(0o077)
STATE.mkdir(parents=True,exist_ok=True)
lock=open(STATE/'supervisor.lock','w')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
password=(CONFIG/'mobile-remote-password').read_text().strip()
auth=base64.b64encode(('opencode:'+password).encode()).decode()
children={};handles={};stopping=False;failures={};last=0
backoff={};next_attempt={};conflict={}
MAX_BACKOFF=60

def atomic(name,value):
 p=STATE/(name+'.tmp');p.write_text(value);p.replace(STATE/name)
def stop(*args):
 global stopping
 stopping=True
 for name,p in children.items():
  if p.poll() is None:p.terminate()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)

class Adopted:
 """Stand-in for a process this supervisor did not spawn (e.g. survived a
 supervisor restart) but has verified is a healthy, correct instance of the
 command for this slot. Never sent a signal unless our own health checks
 later decide the real process needs restarting -- adopting it is the
 alternative to blindly starting a second instance on the same port."""
 def __init__(self,pid):self.pid=pid
 def poll(self):
  try:os.kill(self.pid,0);return None
  except ProcessLookupError:return 0
  except PermissionError:return None
 def terminate(self):
  try:os.kill(self.pid,signal.SIGTERM)
  except ProcessLookupError:pass
 def kill(self):
  try:os.kill(self.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 def wait(self,timeout=None):
  deadline=time.monotonic()+(timeout or 8)
  while self.poll() is None and time.monotonic()<deadline:time.sleep(0.2)
  if self.poll() is None:raise subprocess.TimeoutExpired('adopted',timeout)

def spawn(name,args,env):
 if name in handles:handles[name].close()
 log=STATE/(name+'.log')
 if log.exists() and log.stat().st_size>4_000_000:log.replace(STATE/(name+'.previous.log'))
 handles[name]=open(log,'a');os.chmod(log,0o600)
 children[name]=subprocess.Popen(args,cwd=STATE,env=env,stdout=handles[name],stderr=subprocess.STDOUT)
 atomic(name+'.pid',str(children[name].pid));failures[name]=0
 print(time.strftime('%Y-%m-%dT%H:%M:%S%z')+' '+name+' started (pid '+str(children[name].pid)+')',flush=True)
def healthy(url,json_key=None):
 try:
  # 20s (was 8s): under heavy local load the serve can take >8s to answer
  # /global/health, and the old timeout caused false "health failed 3x" ->
  # restart loops (and a proxy EADDRINUSE race). Real failures are still
  # detected, just without mistaking a busy Mac for a dead one.
  with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Basic '+auth,'User-Agent':'curl/8.7.1'}),timeout=20) as r:
   return r.status==200 and (bool(json.load(r).get(json_key)) if json_key else True)
 except Exception:return False
def port_owner_pid(port):
 try:
  out=subprocess.run(['lsof','-ti',f'tcp:{port}','-sTCP:LISTEN'],capture_output=True,text=True,timeout=3).stdout.split()
  return int(out[0]) if out else None
 except Exception:return None
def tcp_open(host,port,timeout=1.5):
 try:
  with socket.create_connection((host,port),timeout=timeout):return True
 except Exception:return False
def note_crash(name):
 backoff[name]=min(MAX_BACKOFF,max(5,backoff.get(name,0)*2))
 next_attempt[name]=time.monotonic()+backoff[name]
def note_ok(name):
 backoff[name]=0;next_attempt.pop(name,None);conflict.pop(name,None)

# Ports this supervisor itself owns and must not blindly double-bind.
# name -> (port, health url, health json key)
OWNED_PORTS={
 'server':(4096,'http://127.0.0.1:4096/global/health','healthy'),
 'proxy':(4097,'http://127.0.0.1:4097/global/health','healthy'),
}

env=os.environ.copy();env.pop('OPENCODE_DISABLE_CHANNEL_DB',None);env.update(OPENCODE_SERVER_USERNAME='opencode',OPENCODE_SERVER_PASSWORD=password)
atomic('server-password',password)
commands={
 'server':([str(ROOT/'packages/opencode/dist/opencode-darwin-x64/bin/opencode'),'serve','--hostname','127.0.0.1','--port','4096'],env),
 'proxy':(['/usr/local/bin/node',str(ROOT/'script/mobile-remote-proxy.cjs')],env),
 'tunnel':(['/usr/local/bin/cloudflared','tunnel','--no-autoupdate','--protocol','auto','--metrics','127.0.0.1:20496','run','--token-file',str(CONFIG/'mobile-remote-tunnel-token')],None)}

def try_start(name,args,e):
 """Start `name`, unless a healthy instance of it is already listening on its
 port (adopt that instead of spawning a duplicate) or the port is held by
 something else entirely (log the conflict once, back off, never hammer)."""
 if name in OWNED_PORTS:
  port,url,key=OWNED_PORTS[name]
  if tcp_open('127.0.0.1',port):
   if healthy(url,key):
    pid=port_owner_pid(port)
    if pid and pid!=os.getpid():
     if conflict.pop(name,None):print(name+': port '+str(port)+' conflict cleared, adopting healthy pid '+str(pid),flush=True)
     children[name]=Adopted(pid);atomic(name+'.pid',str(pid));note_ok(name)
     return
   pid=port_owner_pid(port)
   msg=name+': port '+str(port)+' is occupied by pid '+str(pid or '?')+' and it is NOT answering as a healthy OpenCode remote component; refusing to start a duplicate'
   if conflict.get(name)!=msg:print(msg,flush=True);conflict[name]=msg
   note_crash(name)
   return
 spawn(name,args,e)
 note_ok(name)

try:
 while not stopping:
  for name,(args,e) in commands.items():
   if stopping:break
   if name in children and children[name].poll() is None:continue
   if time.monotonic()<next_attempt.get(name,0):continue
   if name in children and children[name].poll() is not None and not isinstance(children[name],Adopted):
    note_crash(name)
   try_start(name,args,e)
  if time.monotonic()-last>30 and not stopping:
   last=time.monotonic()
   checks={'server':healthy('http://127.0.0.1:4096/global/health','healthy'),'proxy':healthy('http://127.0.0.1:4097/global/health','healthy'),'tunnel':healthy('http://127.0.0.1:20496/ready')}
   remote=healthy(REMOTE+'/__opencode_remote/status','healthy')
   now=time.time()
   atomic('service-health.json',json.dumps({
    'local':checks['server'],'opencode':checks['server'],'proxy':checks['proxy'],'tunnel':checks['tunnel'],
    'published':remote,'connected':remote,'transport':'named-tunnel-vpc',
    'conflicts':conflict or None,'checked':now,'timestamp':now}))
   for name,ok in checks.items():
    if ok:note_ok(name);failures[name]=0;continue
    failures[name]=failures.get(name,0)+1
    if failures[name]>=3 and name in children and children[name].poll() is None and name not in conflict:
     print(name+' health failed 3x; restarting (pid '+str(children[name].pid)+')',flush=True)
     children[name].terminate()
     try:children[name].wait(timeout=8)
     except subprocess.TimeoutExpired:children[name].kill()
     failures[name]=0;note_crash(name)
   for name in (*commands,'supervisor'):
    logpath=STATE/(name+'.log')
    if logpath.exists() and logpath.stat().st_size>4_000_000:
     with logpath.open('rb') as source:
      source.seek(-1_000_000,2);tail=source.read()
     (STATE/(name+'.previous.log')).write_bytes(tail)
     with logpath.open('w'):pass
  for _ in range(5):
   if stopping:break
   time.sleep(1)
finally:
 stop()
 for p in children.values():
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait()
 now=time.time()
 atomic('service-health.json',json.dumps({'local':False,'opencode':False,'published':False,'connected':False,'stopped':True,'checked':now,'timestamp':now}))
