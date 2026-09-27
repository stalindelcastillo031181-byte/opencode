const COOKIE = 'opencode_auth_token';
const ORIGIN = 'http://127.0.0.1:4097';
function reply(body, status = 200, headers = {}) {
 return new Response(body, {status, headers: {'content-type':'text/plain;charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',...headers}});
}
function login(message = '') {
 return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCode · Acceso remoto</title><style>body{font:17px system-ui;background:#101113;color:#f2f2f2;margin:0;display:grid;min-height:100dvh;place-items:center}main{width:min(360px,85vw)}h1{font-size:28px}p{color:#b6b6bd;line-height:1.5}input,button{box-sizing:border-box;width:100%;padding:15px;border-radius:9px;font:inherit;margin-top:12px}input{background:#202126;border:1px solid #555;color:white}button{border:0;background:#e6f4cf;cursor:pointer}label{display:block;margin-top:28px}</style><main><h1>OpenCode remoto</h1><p>Continúa con tus proyectos del Mac.</p><form method="post" action="/__opencode_remote/login"><label for="password">Contraseña de acceso</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Entrar</button></form><p role="status">${message}</p></main></html>`;
}
function credential(request,url) {
 const query=url.searchParams.get('auth_token');if(query)return query;
 const basic=/^Basic\s+(.+)$/i.exec(request.headers.get('authorization')||'');if(basic)return basic[1];
 try{return decodeURIComponent((request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'');}catch{return '';}
}
async function health(env,token) {
 try { const r=await env.OPENCODE.fetch(new Request(ORIGIN+'/global/health',{headers:{authorization:'Basic '+token},signal:AbortSignal.timeout(10000)}));
 if(r.status===401)return {status:401};if(!r.ok)return {status:503};const b=await r.json();return {status:b.healthy===true?200:503,version:b.version};
 }catch{return {status:503};}
}
export default {async fetch(request,env) {
 const url=new URL(request.url);
 const changing=!['GET','HEAD','OPTIONS'].includes(request.method)||request.headers.get('upgrade')?.toLowerCase()==='websocket';
 if(changing){const origin=request.headers.get('origin');// no-referrer makes Safari send Origin: null on same-origin form posts; sec-fetch-site still proves same-origin.
 if(origin&&origin!==url.origin&&!(origin==='null'&&request.headers.get('sec-fetch-site')==='same-origin'))return reply('Forbidden',403);if(request.headers.get('sec-fetch-site')==='cross-site')return reply('Forbidden',403);}
 if(url.pathname==='/__opencode_remote/origin')return reply('El túnel permanente no usa publicación de orígenes.',410);
 if(url.pathname==='/__opencode_remote/logout'){
 if(request.method!=='POST')return reply('Method Not Allowed',405);
 return reply('',303,{'location':'/','set-cookie':`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`});}
 let token=credential(request,url);
 if(url.pathname==='/__opencode_remote/login'){
 if(request.method!=='POST')return reply('Method Not Allowed',405);
 if(Number(request.headers.get('content-length')||0)>4096)return reply('Request too large',413);
 const form=await request.formData();const password=form.get('password');
 if(typeof password!=='string'||password.length>256)return reply('Invalid password',400);
 token=btoa('opencode:'+password);
 const result=await health(env,token);
 if(result.status!==200)return reply(login(result.status===401?'La contraseña no es válida.':'El Mac está desconectado. Inténtalo de nuevo.'),result.status,{'content-type':'text/html;charset=utf-8'});
 return reply('',303,{'location':'/','set-cookie':`${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`});
 }
 if(!token){const page=url.pathname==='/'||(request.method==='GET'&&request.headers.get('sec-fetch-mode')==='navigate');return reply(page?login():'Unauthorized',401,{'content-type':page?'text/html;charset=utf-8':'text/plain;charset=utf-8'});}
 if(url.searchParams.has('auth_token')){
 const result=await health(env,token);if(result.status!==200)return reply('Acceso no válido o Mac desconectado',result.status);
 url.searchParams.delete('auth_token');return reply('',303,{'location':url.pathname+url.search,'set-cookie':`${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`});}
 if(url.pathname==='/__opencode_remote/status'){
 const result=await health(env,token);
 const body={connected:result.status===200,healthy:result.status===200,transport:'named-tunnel-vpc',version:result.version};
 // Best-effort: merge the supervisor's own per-component view (opencode/proxy/tunnel/timestamp) so a
 // caller can tell "the Mac is unreachable" apart from "the Mac answered but the tunnel flapped a minute
 // ago". Never invents green: if this fetch fails, the fields are simply absent, not defaulted to true.
 try {
  const local=await env.OPENCODE.fetch(new Request(ORIGIN+'/__opencode_remote/local-status',{headers:{authorization:'Basic '+token},signal:AbortSignal.timeout(6000)}));
  if(local.ok){const l=await local.json();body.opencode=l.opencode;body.proxy=l.proxy;body.tunnel=l.tunnel;body.conflicts=l.conflicts??null;body.timestamp=l.timestamp;}
 } catch {}
 return reply(JSON.stringify(body),result.status,{'content-type':'application/json'});}
 const target=new URL(url.pathname+url.search,ORIGIN);
 const headers=new Headers(request.headers);headers.set('authorization','Basic '+token);headers.set('origin',ORIGIN);headers.set('x-forwarded-proto','https');headers.delete('cookie');headers.delete('x-opencode-control-token');
 try {
 const response=await env.OPENCODE.fetch(new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
 if(response.status===101)return response;
 // Stale cookie (e.g. password rotated): clear it and show the login page instead of a bare 12-byte body iOS downloads as a file.
 if(response.status===401){const expire=`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
 if(request.method==='GET'&&(request.headers.get('sec-fetch-mode')==='navigate'||(request.headers.get('accept')||'').includes('text/html')))return reply(login('La sesión caducó. Vuelve a entrar.'),401,{'content-type':'text/html;charset=utf-8','set-cookie':expire});
 return reply('Unauthorized',401,{'content-type':'text/plain;charset=utf-8','set-cookie':expire});}
 const out=new Headers(response.headers);out.delete('www-authenticate');out.delete('set-cookie');out.set('cache-control','no-store');out.set('referrer-policy','no-referrer');out.set('x-content-type-options','nosniff');
 if(out.get('x-opencode-event-stream')==='1'){out.set('content-type','text/event-stream');out.delete('x-opencode-event-stream');}
 return new Response(response.body,{status:response.status,headers:out});
 }catch{return reply('El Mac está desconectado. El acceso se recuperará al reconectarlo.',503);}
}};
