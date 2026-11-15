import qrcode from './vendor/qrcode.mjs';

/** Explicit refresh preserves selection and QR; no periodically rebuilt panel. */
export async function mountLan(container,{el,button,request}){
  container.append(el('h2',{class:'h3'},'Удалённый доступ'));
  if(location.protocol==='https:'){
    container.append(el('p',{},'Телефон подключён. В меню браузера выберите «Добавить на главный экран». Управление подключениями — в блоке «Удалённый доступ» рядом с загрузкой модели на компьютере.'),el('form',{method:'post',action:'/__lan/logout'},el('button',{type:'submit',class:'st-btn'},'Выйти на этом устройстве')));
    return;
  }
  const message=el('p',{role:'status'}),body=el('div',{class:'stack stack--lg'}),qrArea=el('div',{});
  container.append(message,body,qrArea);
  let busy=false;
  async function act(action){
    if(busy)return;
    busy=true;message.textContent='Подождите…';
    try{const value=await request('/strata-ui/lan',action);message.textContent='';render(value);}
    catch(error){message.textContent=error.message;}
    finally{busy=false;}
  }
  function render(state){
    body.replaceChildren();
    if(!state.configured){body.append(el('p',{},'Локальный доступ ещё не настроен: нужны адрес и сертификат компьютера.'));return;}
    for(const warning of state.warnings??[])body.append(el('p',{role:'status',class:'sx-notice'},warning));
    body.append(el('strong',{},state.enabled===null?'Состояние сети неизвестно':state.enabled?'● Доступ по сети включён':'○ Доступ по сети выключен'),el('input',{class:'st-input',readOnly:true,value:state.url,'aria-label':'Адрес Strata'}),el('div',{class:'sx-row'},button(state.enabled?'Выключить':'Включить',()=>act({action:state.enabled?'disable':'enable'})),button('Обновить статус',()=>act()),button('Скопировать адрес',async()=>{try{await navigator.clipboard.writeText(state.url);message.textContent='Адрес скопирован.';}catch{message.textContent='Выделите и скопируйте адрес из поля.';}})));
    body.append(el('label',{},el('input',{type:'checkbox',checked:state.autostart===true,disabled:state.autostart===null,onchange:e=>act({action:'autostart',enabled:e.target.checked})}),' Запускать вместе с Windows'));
    body.append(el('details',{},el('summary',{},'Как подключиться'),el('p',{class:'sx-muted'},'На телефоне один раз установите сертификат и добавьте Strata на главный экран через меню браузера. Подключение запоминается на год и продлевается при использовании. После очистки данных браузера потребуется войти заново. Закрепите адрес компьютера в настройках роутера. Автозапуск действует после входа в Windows.')));
    body.append(button('Подключить телефон · показать QR',async()=>{
      if(busy)return;
      busy=true;
      try{
        const pair=await request('/strata-ui/lan',{action:'pair'}),qr=qrcode(0,'M');
        qr.addData(pair.url);qr.make();
        const image=el('div',{'aria-label':'Одноразовый QR подключения'});
        image.innerHTML=qr.createSvgTag({cellSize:4,margin:4,scalable:true});
        image.style.cssText='width:min(280px,100%);background:white;padding:12px';
        const address=el('input',{class:'st-input',readOnly:true,value:pair.url,'aria-label':'Ссылка подключения'});
        qrArea.replaceChildren(image,el('p',{},'Отсканируйте камерой телефона и нажмите «Подключить». QR одноразовый, действует до '+new Date(pair.expires).toLocaleTimeString()+'.'),address,button('Копировать ссылку подключения',async()=>{try{await navigator.clipboard.writeText(pair.url);message.textContent='Ссылка подключения скопирована.';}catch{address.focus();address.select();message.textContent='Скопируйте выделенную ссылку.';}}),button('Скрыть QR',()=>qrArea.replaceChildren()));
      }catch(error){message.textContent=error.message;}finally{busy=false;}
    }));
    body.append(el('h3',{},'Подключённые устройства'));
    if(!state.devices.length)body.append(el('p',{},'Пока нет подключённых устройств.'));
    for(const device of state.devices)body.append(el('div',{class:'sx-card'},el('strong',{},device.label),el('p',{},'Последнее использование: '+new Date(device.lastUsed).toLocaleString()),button('Отключить доступ',()=>act({action:'revoke',id:device.id}))));
    if(!state.enabled)qrArea.replaceChildren();
  }
  await act();
}

/** Mount one native-style card beside model/engine controls. Repeated host
 * renders preserve the node, its selection and any expanded QR. */
export function scanRemoteAccess(api,root=document){
  const parent=root.querySelector('.native-model-layout > aside')??root.querySelector('.run-setup');
  if(!parent||parent.querySelector('[data-sx-remote-access]'))return;
  const card=api.el('section',{class:'st-card stack stack--lg sx-remote-access','data-sx-remote-access':'','aria-label':'Удалённый доступ'});
  parent.append(card);
  mountLan(card,api).catch(error=>card.append(api.el('p',{role:'alert'},error.message)));
}

export function installPhoneShortcut(){
  if(location.protocol!=='https:'||document.querySelector('link[rel="manifest"]'))return ()=>{};
  const link=document.createElement('link');link.rel='manifest';link.href='/__lan/manifest.webmanifest';document.head.append(link);
  return ()=>link.remove();
}
