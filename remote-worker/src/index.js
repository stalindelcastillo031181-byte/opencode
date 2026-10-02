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
 try { const r=await env.OPENCODE_NET.fetch(new Request(ORIGIN+'/global/health',{headers:{authorization:'Basic '+token},signal:AbortSignal.timeout(10000)}));
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
 if(!token){return reply('OpenCode remoto no está disponible todavía.',503);}
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
  const local=await env.OPENCODE_NET.fetch(new Request(ORIGIN+'/__opencode_remote/local-status',{headers:{authorization:'Basic '+token},signal:AbortSignal.timeout(6000)}));
  if(local.ok){const l=await local.json();body.opencode=l.opencode;body.proxy=l.proxy;body.tunnel=l.tunnel;body.conflicts=l.conflicts??null;body.timestamp=l.timestamp;}
 } catch {}
 return reply(JSON.stringify(body),result.status,{'content-type':'application/json'});}
 const target=new URL(url.pathname+url.search,ORIGIN);
 const headers=new Headers(request.headers);headers.set('authorization','Basic '+token);headers.set('origin',ORIGIN);headers.set('x-forwarded-proto','https');headers.delete('cookie');headers.delete('x-opencode-control-token');
 try {
 const response=await env.OPENCODE_NET.fetch(new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
 if(response.status===101)return response;
 // Stale cookie (e.g. password rotated): clear it and show the login page instead of a bare 12-byte body iOS downloads as a file.
 if(response.status===401){const expire=`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
 if(request.method==='GET'&&(request.headers.get('sec-fetch-mode')==='navigate'||(request.headers.get('accept')||'').includes('text/html')))return reply(login('La sesión caducó. Vuelve a entrar.'),401,{'content-type':'text/html;charset=utf-8','set-cookie':expire});
 return reply('Unauthorized',401,{'content-type':'text/plain;charset=utf-8','set-cookie':expire});}
 const out=new Headers(response.headers);out.delete('www-authenticate');out.delete('set-cookie');out.set('cache-control','no-store');out.set('referrer-policy','no-referrer');out.set('x-content-type-options','nosniff');
 if(out.get('x-opencode-event-stream')==='1'){out.set('content-type','text/event-stream');out.delete('x-opencode-event-stream');}
 if((out.get('content-type')||'').includes('text/html')){
  const css=`<style id="stalin-mobile-fix">:root{color-scheme:light!important}*{box-sizing:border-box}html,body,#root{background:#f8f9fb!important;color:#111827!important;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",system-ui,sans-serif;-webkit-text-size-adjust:100%}body{margin:0!important;min-height:100dvh!important;padding:max(10px,env(safe-area-inset-top)) 10px max(18px,env(safe-area-inset-bottom))!important;font-size:16px;line-height:1.35}body:before{content:"opencode  REMOTE";display:block;padding:14px 12px 18px;color:#0f172a;font-size:20px;font-weight:850;letter-spacing:-.04em;border-bottom:1px solid #e7eaf0}body>*{width:100%;max-width:760px;margin-inline:auto}a{display:flex!important;align-items:center!important;min-height:54px!important;margin:8px 0!important;padding:12px 14px!important;border:1px solid #e5e7eb!important;border-radius:14px!important;background:#fff!important;color:#111827!important;text-decoration:none!important;font-weight:650!important;overflow-wrap:anywhere;box-shadow:0 4px 18px #0f172a0d!important}button,input,select,textarea{font:inherit!important;min-height:46px!important;border-radius:13px!important;border:1px solid #dfe3e8!important;background:#fff!important;color:#111827!important;padding:10px 13px!important;box-shadow:none!important}button{min-width:46px!important;font-weight:700!important}h1,h2,h3{color:#111827!important;letter-spacing:-.025em}small{color:#6b7280!important}[class*="bg-black"],[class*="bg-neutral-9"],[class*="bg-gray-9"],[style*="background: black"],[style*="background-color: black"],[style*="background:#000"],[style*="background-color:#000"]{background:#fff!important;color:#111827!important}form[data-mobile-composer="1"]{position:fixed!important;left:12px!important;right:12px!important;bottom:max(8px,env(safe-area-inset-bottom))!important;width:auto!important;z-index:999!important;background:#fff!important;border:1px solid #e2e6ec!important;border-radius:18px!important;box-shadow:0 14px 42px #0f172a20!important;padding-bottom:0!important;max-width:none!important}#mobile-media-tools{position:absolute;left:10px;right:10px;bottom:8px;display:flex;gap:7px;z-index:1000}#mobile-media-tools button{flex:1!important;min-width:0!important;min-height:38px!important;padding:7px 9px!important;border:1px solid #dfe3e8!important;border-radius:11px!important;background:#f8fafc!important;color:#111827!important;font-size:12px!important;font-weight:700!important}@media(max-width:480px){html,body,#root{height:100%!important;min-height:100%!important;overflow:hidden!important}body{padding:0!important}body:before{content:none!important}body>*{max-width:none!important}a{min-height:46px!important;border-radius:12px!important;font-size:14px!important}button{min-height:40px!important}form[data-mobile-composer="1"]{left:8px!important;right:8px!important;bottom:max(6px,env(safe-area-inset-bottom))!important;border-radius:17px!important}#mobile-media-tools{left:8px;right:8px;gap:6px}#mobile-media-tools button{min-height:36px!important;font-size:12px!important}main,[role="main"]{height:100dvh!important;max-height:100dvh!important;overflow:auto!important;padding-bottom:190px!important}nav,aside,[data-component*="sidebar"],[data-slot*="sidebar"]{max-height:100dvh!important;overflow:auto!important}}</style>`;
  const mobile=`<script id="stalin-mobile-ui">(()=>{const boot=()=>{const editor=document.querySelector('[data-component="prompt-input"]');if(!editor)return setTimeout(boot,400);editor.closest('form')?.setAttribute('data-mobile-composer','1')};boot();new MutationObserver(boot).observe(document.documentElement,{childList:true,subtree:true})})();</script>`;
  let html=await response.text();html=html.includes('</head>')?html.replace('</head>',css+mobile+'</head>'):html.replace(/<body([^>]*)>/i,'<head>'+css+mobile+'</head><body$1>');
  out.delete('content-length');out.set('content-security-policy',"default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src * data: blob:");return new Response(html,{status:response.status,headers:out});
 }
 return new Response(response.body,{status:response.status,headers:out});
 }catch{return reply('El Mac está desconectado. El acceso se recuperará al reconectarlo.',503);}
}};
