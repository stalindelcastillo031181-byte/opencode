import pathlib,os,sys,urllib.request,urllib.parse,base64,json,time,subprocess
home=pathlib.Path.home();state=home/'.local/state/opencode-mobile-remote';base='https://opencode-remote-stalin.pages.dev'
password=(home/'.config/opencode/mobile-remote-password').read_text().strip();token=base64.b64encode(('opencode:'+password).encode()).decode()
mode=sys.argv[1] if len(sys.argv)>1 else 'status'
for attempt in range(12 if mode in ['link','open'] else 1):
 try:
  with urllib.request.urlopen(urllib.request.Request(base+'/__opencode_remote/status',headers={'Authorization':'Basic '+token,'User-Agent':'curl/8.7.1'}),timeout=12) as r:status=json.load(r)
  if status.get('healthy'):break
 except Exception:status={'healthy':False}
 if attempt<11 and mode in ['link','open']:time.sleep(2)
if not status.get('healthy'):print('OpenCode remoto no está disponible. Revisa el estado del Mac y la conexión.',file=sys.stderr);sys.exit(1)
if mode=='status':print('OpenCode remoto OPERATIVO · túnel permanente\n'+base);sys.exit(0)
path='/'
if os.getenv('OPENCODE_REMOTE_SESSION_ID') and os.getenv('OPENCODE_REMOTE_DIRECTORY'):
 directory=base64.urlsafe_b64encode(os.environ['OPENCODE_REMOTE_DIRECTORY'].encode()).decode().rstrip('=')
 path=f'/{directory}/session/{urllib.parse.quote(os.environ["OPENCODE_REMOTE_SESSION_ID"],safe="")}'
url=base+path+'?auth_token='+urllib.parse.quote(token,safe='')
os.umask(0o077);(state/'current-url').write_text(url+'\n')
if mode=='open':subprocess.run(['/usr/bin/open',url],check=True)
else:print(url)
