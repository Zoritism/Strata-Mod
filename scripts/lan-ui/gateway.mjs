import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {isIPv4} from 'node:net';
import {loginPage,manifest,icon} from './login.mjs';

const numericIp=address=>address.split('.').reduce((value,part)=>(value<<8)|Number(part),0)>>>0;
const digest=value=>createHash('sha256').update(value).digest();
const readMethods=new Set(['GET','HEAD']);
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);

/** Keep privileged desktop controls out of the authenticated phone surface,
 * including both addresses during the LAN owner's extension migration. */
export function desktopOnlyPath(pathname){
  return /^\/(?:v1(?:\/|$)|api\/(?:control|app\/drop|internal)(?:\/|$))/.test(pathname)||
    pathname==='/api/app/quit'||pathname.startsWith('/api/extensions/lan')||pathname.startsWith('/api/extensions/strata-ui/lan');
}

function end(res,status,message,headers={}){
  res.writeHead(status,{'cache-control':'no-store','content-type':'text/plain; charset=utf-8',...headers});
  res.end(message);
}

// A loopback proxy deliberately authenticates before translating Host or
// Origin. Browser protections in Strata remain active on the upstream hop.
function forwarded(headers){
  const named=String(headers.connection??'').toLowerCase().split(',').map(s=>s.trim());
  const blocked=new Set([...named,'connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-connection','proxy-authenticate','proxy-authorization']);
  return Object.fromEntries(Object.entries(headers).filter(([name])=>!blocked.has(name)));
}

export function createGateway({address,port,subnet,upstreamPort,password,pfx,auth,cookie,tokenFromCookie}){
  if(!isIPv4(address)||!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)||
    !Number.isInteger(subnet)||subnet<8||subnet>30||
    ![port,upstreamPort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||
    !/^[a-f0-9]{32}$/.test(password))throw Error('Неверная конфигурация доступа Strata по сети.');
  const authority=address+':'+port;
  const origin='https://'+authority;
  const upstreamHost='127.0.0.1:'+upstreamPort;
  const upstreamOrigin='http://'+upstreamHost;
  const subnetMask=(0xffffffff<<(32-subnet))>>>0;
  const network=numericIp(address)&subnetMask;
  const expected=digest(password);
  const attempts=new Map(); // bounded per-address login throttling
  async function form(req){
    let text='';
    for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>4096)throw Error('Слишком большой запрос.');}
    return new URLSearchParams(text);
  }

  return https.createServer({pfx,minVersion:'TLSv1.2'},async (req,res)=>{
    try {
    const source=req.socket.remoteAddress;
    if(!isIPv4(source)||(numericIp(source)&subnetMask)!==network||req.headers.host!==authority)
      return end(res,403,'Доступ разрешён с адресов этой локальной сети.');

    const {method,url,headers}=req;
    if(!methods.has(method)||!/^\/(?!\/)/.test(url)||/[\\\s#]/.test(url))
      return end(res,400,'Недопустимый запрос.');
    const pathname=new URL(url,origin).pathname;
    // Scanner/WebView entry requests may omit Fetch Metadata or use an opaque
    // origin. These two GET pages are public and issue no credentials. Token
    // redemption, authenticated APIs and all writes keep their origin checks.
    const publicEntry=method==='GET'&&['/__lan/login','/__lan/pair'].includes(pathname);
    const entryNavigation=publicEntry||(method==='GET'&&pathname==='/'&&headers['sec-fetch-mode']==='navigate'&&headers['sec-fetch-dest']==='document');
    if(!entryNavigation&&(headers['sec-fetch-site']==='cross-site'||(headers.origin&&headers.origin!==origin)||
      (!readMethods.has(method)&&headers.origin!==origin&&headers['sec-fetch-site']!=='same-origin'))
    )
      return end(res,403,'Откройте Strata напрямую в браузере.');

    if(method==='GET'&&pathname==='/__lan/manifest.webmanifest')return end(res,200,JSON.stringify(manifest),{'content-type':'application/manifest+json'});
    if(method==='GET'&&pathname==='/__lan/icon.svg')return end(res,200,icon,{'content-type':'image/svg+xml'});
    // Preserve the form's same-origin Origin header. no-referrer makes browsers
    // send Origin: null on POST, which correctly fails our CSRF boundary.
    if(method==='GET'&&['/__lan/login','/__lan/pair'].includes(pathname))return end(res,200,loginPage(pathname.endsWith('pair')),{'content-type':'text/html; charset=utf-8','referrer-policy':'same-origin'});
    if(method==='POST'&&['/__lan/login','/__lan/pair'].includes(pathname)){
      const at=Date.now();
      for(const [ip,entry] of attempts)if(at-entry.start>600000)attempts.delete(ip);
      if(!attempts.has(source)&&attempts.size>=256)return end(res,429,'Попробуйте позже.');
      const rate=attempts.get(source)??{start:at,count:0};
      attempts.set(source,rate);
      if(++rate.count>10)return end(res,429,'Слишком много попыток. Подождите 10 минут.');
      const input=await form(req);
      let issued;
      if(pathname.endsWith('/pair'))issued=auth.redeem(input.get('token')??'',input.get('label'));
      else {
        if(!timingSafeEqual(expected,digest(input.get('password')??'')))return end(res,401,'Неверный пароль. Вернитесь назад и повторите.');
        issued=auth.issue(input.get('label'),input.get('remember')==='1');
      }
      attempts.delete(source);
      return end(res,303,'',{'set-cookie':cookie(issued.token,issued.remember),location:'/'});
    }
    const token=tokenFromCookie(headers.cookie),device=auth.check(token);
    if(!device){
      if(method==='GET'&&(headers.accept??'').includes('text/html'))return end(res,303,'',{location:'/__lan/login'});
      return end(res,401,JSON.stringify({error:'Откройте страницу Strata и войдите заново.'}),{'content-type':'application/json'});
    }
    if(method==='POST'&&pathname==='/__lan/logout'){
      auth.revoke(device.id);
      return end(res,303,'',{'set-cookie':cookie('')+'; Max-Age=0',location:'/__lan/login'});
    }
    if(device.remember)res.setHeader('set-cookie',cookie(token));
    if(desktopOnlyPath(pathname))
      return end(res,404,'Эта команда доступна в окне Strata на компьютере.');

    const incoming=forwarded(headers);
    for(const key of Object.keys(incoming)){
      if(['authorization','cookie','forwarded','x-strata-shutdown'].includes(key)||key.startsWith('x-forwarded-'))delete incoming[key];
    }
    incoming.host=upstreamHost;
    if(incoming.origin)incoming.origin=upstreamOrigin;
    if(incoming.referer?.startsWith(origin+'/'))incoming.referer=upstreamOrigin+incoming.referer.slice(origin.length);
    else delete incoming.referer;
    const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:url,method,headers:incoming},reply=>{
      const outgoing=forwarded(reply.headers);
      for(const key of Object.keys(outgoing))if(key.startsWith('access-control-'))delete outgoing[key];
      outgoing['cache-control']='no-store';
      if(outgoing.location?.startsWith(upstreamOrigin+'/'))outgoing.location=origin+outgoing.location.slice(upstreamOrigin.length);
      res.writeHead(reply.statusCode,outgoing);
      reply.on('error',()=>res.destroy());
      reply.pipe(res);
    });
    upstream.on('error',()=>{
      if(!res.headersSent&&!res.destroyed)end(res,502,'Запустите Strata-Mod на компьютере.');
      else res.destroy();
    });
    res.on('close',()=>upstream.destroy());
    // Preserve streaming chat and byte ranges without buffering media.
    req.pipe(upstream);
    }catch(error){if(!res.headersSent)end(res,400,error.message);else res.destroy();}
  });
}

if(import.meta.main){
  const directory=process.argv[2];
  if(!directory)throw Error('Укажите папку настроек Strata LAN.');
  const config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8'));
  const password=fs.readFileSync(path.join(directory,'access.txt'),'utf8').trim();
  const pfx=fs.readFileSync(path.join(directory,'server.pfx'));
  const {deviceStore,cookie,tokenFromCookie}=await import('../../extensions/core/lan-auth.mjs');
  const server=createGateway({...config,password,pfx,auth:deviceStore(directory),cookie,tokenFromCookie});
  server.listen(config.port,config.address,()=>console.log('Strata LAN: https://'+config.address+':'+config.port+'/'));
}
