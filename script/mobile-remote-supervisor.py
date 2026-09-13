import os, pathlib, subprocess, time, signal, urllib.request, re, json, base64
ROOT=pathlib.Path('/Users/stalindelcasttillo/opencode-mobile-fixed')
STATE=pathlib.Path('/Users/stalindelcasttillo/.local/state/opencode-mobile-remote')
CONFIG=pathlib.Path('/Users/stalindelcasttillo/.config/opencode')
REMOTE='https://opencode-remote-stalin.pages.dev'
os.umask(0o077)
password=(CONFIG/'mobile-remote-password').read_text().strip()
control=(CONFIG/'mobile-remote-control-token').read_text().strip()
auth=base64.b64encode(('opencode:'+password).encode()).decode()
children={}; handles={}; stopping=False

def request(url,method='GET',data=None,headers=None):
 return urllib.request.urlopen(urllib.request.Request(url,data=data,method=method,headers={'User-Agent':'curl/8.7.1',**(headers or {})}),timeout=12)
def stop(*args):
 global stopping
 stopping=True
 for p in children.values():
  if p.poll() is None:p.terminate()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
def spawn(name,args,env=None):
 if name in handles:handles[name].close()
 log=STATE/(name+'.log')
 if log.exists() and log.stat().st_size>4_000_000:log.replace(STATE/(name+'.previous.log'))
 handles[name]=open(log,'w' if name=='tunnel' else 'a')
 children[name]=subprocess.Popen(args,cwd=STATE,env=env,stdout=handles[name],stderr=subprocess.STDOUT)
 (STATE/(name+'.pid')).write_text(str(children[name].pid))
 print(name+' started',flush=True)
env=os.environ.copy();env.update(OPENCODE_SERVER_USERNAME='opencode',OPENCODE_SERVER_PASSWORD=password,OPENCODE_DISABLE_CHANNEL_DB='1')
(STATE/'server-password').write_text(password)
os.chmod(STATE/'server-password',0o600)
commands={
 'server':([str(ROOT/'packages/opencode/dist/opencode-darwin-x64/bin/opencode'),'serve','--hostname','127.0.0.1','--port','4096'],env),
 'proxy':(['/usr/local/bin/node',str(ROOT/'script/mobile-remote-proxy.cjs')],env),
 'tunnel':(['/usr/local/bin/cloudflared','tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:4097'],None)}
origin='';published='';last=0;origin_failures=0
while not stopping:
 for name,(args,e) in commands.items():
  if name not in children or children[name].poll() is not None:
   spawn(name,args,e)
   if name=='tunnel':origin='';published=''
 try:
  matches=re.findall(r'https://[-a-z0-9]+\.trycloudflare\.com',(STATE/'tunnel.log').read_text())
  if matches:origin=matches[-1]
  if origin and (origin!=published or time.time()-last>60):
   with request('http://127.0.0.1:4096/global/health',headers={'Authorization':'Basic '+auth}) as r:healthy=json.load(r).get('healthy')
   if healthy:
    try:
     with request(origin+'/global/health',headers={'Authorization':'Basic '+auth}) as r: origin_healthy=json.load(r).get('healthy')
     if not origin_healthy:raise RuntimeError('tunnel origin unhealthy')
     origin_failures=0
    except Exception:
     origin_failures+=1
     if origin_failures>=3 and children['tunnel'].poll() is None:
      children['tunnel'].terminate();origin='';published='';origin_failures=0
      (STATE/'service-health.json').write_text(json.dumps({'local':True,'published':False,'checked':time.time()}))
     time.sleep(5);continue
    with request(REMOTE+'/__opencode_remote/origin','PUT',origin.encode(),{'x-opencode-control-token':control,'content-type':'text/plain'}) as r: assert r.status==200
    published=origin;last=time.time();(STATE/'tunnel-origin').write_text(origin)
    (STATE/'service-health.json').write_text(json.dumps({'local':True,'published':True,'checked':last}))
 except Exception as e:
  print('health/reconnect: '+type(e).__name__,flush=True)
 time.sleep(5)
for p in children.values():
 try:p.wait(timeout=8)
 except subprocess.TimeoutExpired:p.kill()
