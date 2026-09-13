const http = require('node:http');
const fs=require('node:fs');const crypto=require('node:crypto');
const expected=Buffer.from('Basic '+Buffer.from('opencode:'+fs.readFileSync('/Users/stalindelcasttillo/.config/opencode/mobile-remote-password','utf8').trim()).toString('base64'));
let events=[],sequence=0,connectedFrame='',streamOnline=false;
function subscribe(){
 const request=http.get({hostname:'127.0.0.1',port:4096,path:'/global/event',headers:{authorization:expected.toString()}},r=>{
  if(r.statusCode!==200){r.resume();setTimeout(subscribe,2000);return;}
  streamOnline=true;let pending='';r.setEncoding('utf8');
  r.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end+2);pending=pending.slice(end+2);if(frame.includes('server.connected'))connectedFrame=frame;events.push({id:++sequence,frame});if(events.length>2000)events.shift();}});
  r.on('close',()=>{streamOnline=false;setTimeout(subscribe,1000);});r.on('error',()=>r.destroy());
 });request.on('error',()=>{streamOnline=false;setTimeout(subscribe,2000);});
}
subscribe();
const server = http.createServer((req,res)=>{
 if(req.url.startsWith('/__opencode_remote/events')){
  const supplied=Buffer.from(req.headers.authorization||'');if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){res.writeHead(401);res.end();return;}
  if(!streamOnline){res.writeHead(503);res.end();return;}
  const cursor=Number(new URL(req.url,'http://localhost').searchParams.get('cursor')??'-1');
  const frames=cursor<0?[connectedFrame].filter(Boolean):events.filter(e=>e.id>cursor).map(e=>e.frame);
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({cursor:sequence,frames}));return;
 }

 if(req.url.startsWith('/agent')){
  const urlObj = new URL(req.url, 'http://localhost');
  const agentPath = urlObj.pathname.replace(/^\/agent/, '') || '/';
  const targetPath = agentPath + urlObj.search;
  const proxyReq=http.request({hostname:'127.0.0.1',port:4310,path:targetPath,method:req.method,headers:{...req.headers,host:'127.0.0.1:4310'}},r=>{
   res.writeHead(r.statusCode,{'content-type':r.headers['content-type']||'application/json','cache-control':'no-store','access-control-origin':'*'});
   r.pipe(res);
  });
  proxyReq.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"agent-core unreachable"}');});
  req.pipe(proxyReq);res.on('close',()=>proxyReq.destroy());
  return;
 }

 const upstream=http.request({hostname:'127.0.0.1',port:4096,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:4096'}},r=>{
  const headers={...r.headers};
  if((headers['content-type']||'').includes('text/event-stream')){
   headers['content-type']='application/octet-stream';headers['x-opencode-event-stream']='1';headers['cache-control']='no-store, no-transform';headers['content-encoding']='identity';
  }
  res.writeHead(r.statusCode,headers);res.flushHeaders();if(headers['x-opencode-event-stream'])res.write(':'+ ' '.repeat(16384)+'\n\n');r.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});res.end('{"healthy":false,"connected":false}');});
 req.pipe(upstream);res.on('close',()=>upstream.destroy());
});
server.on('upgrade',(req,socket,head)=>{
 const upstream=http.request({hostname:'127.0.0.1',port:4096,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:4096'}});
 upstream.on('upgrade',(r,peer,data)=>{socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);if(data.length)socket.write(data);if(head.length)peer.write(head);peer.pipe(socket);socket.pipe(peer);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());});
 upstream.on('response',r=>{socket.end(`HTTP/1.1 ${r.statusCode} Rejected\r\nConnection: close\r\n\r\n`);});upstream.on('error',()=>socket.destroy());upstream.end();
});
server.listen(4097,'127.0.0.1');
