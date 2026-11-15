/** Adapt existing native commands instead of storing a second chat history.
 * Editing is staged until Send; closing/cancelling the composer changes nothing. */
export function installChatManagement(api){
  const adapter=()=>globalThis.strataExtensionsChatAdapter;
  const staged=new Map(),submitted=new Map();let sending=false,dragged=null,menuChat=null;
  const notice=error=>{const n=api.el('div',{role:'alert',class:'sx-notice sx-operation-error'},String(error?.message??error));document.body.append(n);setTimeout(()=>n.remove(),9000);};
  const current=()=>adapter()?.get().sessions.find(s=>s.id===adapter().get().activeSession);
  async function flush(chat){
    const result=await adapter().flush();if(result.ok)return;
    // A failure in another chat must not lock every workspace action.
    const failures=(result.failed??[]).filter(f=>!chat||f.id===chat);
    if(!failures.length)return;
    throw Error('Не удалось сохранить чат: '+failures.map(f=>f.message||f.reason||'неизвестная ошибка').join('; '));
  }
  async function run(body){await flush(body.chat);const result=await api.request('/chat-management',{...body,rev:adapter().rev(body.chat)});if(result.session)adapter().adopt(result.session,result.rev);if(result.warning)notice(result.warning);return result;}
  function begin(messageId,retry=false){
    const session=current();if(!session||adapter().get().streaming)return null;
    const message=session.messages.find(m=>m.id===messageId);
    if(!message||(!retry&&message.role!=='user'))return null;
    if(retry&&message!==session.messages.at(-1)){notice('Повтор доступен только у последнего ответа.');return null;}
    const user=retry?[...session.messages].reverse().find(m=>m.role==='user'):message;if(!user)return null;
    staged.set(session.id,{messageId,retry,photos:user.photos??[]});sessionStorage.setItem('strata.chat-draft.'+session.id,user.content);scan();return user.content;
  }
  globalThis.strataExtensionsChat={
    edit:messageId=>begin(messageId),
    async retry(messageId){const session=current();const text=begin(messageId??session?.messages.at(-1)?.id,true);if(text!==null)await adapter().send(text);},
    async beforeSend({text,options}){
      const session=current(),pending=staged.get(session?.id);if(!pending||options.reattach||options.goalAction||options.planId)return true;
      if(sending||!text.trim())return false;sending=true;
      try{
        const result=await run({action:'edit',chat:session.id,...pending,text});
        submitted.set(session.id,result.original);staged.delete(session.id);
        // The saved replacement survives a crash here. Native send appends this
        // same message again to the transient prefix, then persists normally.
        adapter().transient({...result.session,messages:result.session.messages.slice(0,-1)});scan();return true;
      }catch(error){notice(error);return false;}finally{sending=false;}
    },
    photos:photos=>photos.length?photos:(submitted.get(adapter()?.get().activeSession)?.photos??photos),
    user(message){const chat=adapter()?.get().activeSession,original=submitted.get(chat);submitted.delete(chat);return original?{...original,...message,id:original.id}:message;},
  };
  function chatOf(node){const href=node?.closest?.('.ws__session')?.querySelector('a.navsession')?.getAttribute('href')??node?.closest?.('a.navsession')?.getAttribute('href');return /^#\/chat\/([\w-]+)/.exec(href??'')?.[1];}
  function workspaceOf(node){const group=node?.closest?.('.ws__group'),groups=[...document.querySelectorAll('.ws__group')];return adapter()?.get().workspaces[groups.indexOf(group)];}
  function openWorkspace(node){const workspace=workspaceOf(node);if(workspace)api.request('/chat-management',{action:'open-workspace',workspaceId:workspace.id}).catch(notice);}
  document.addEventListener('contextmenu',event=>{
    const chat=chatOf(event.target);if(chat){menuChat=chat;return;}
    if(event.target.closest('.ws__row')){event.preventDefault();workspaceMenu(event.target,event.clientX,event.clientY);}
  },true);
  document.addEventListener('click',event=>{
    if(event.target.closest('.session-overflow'))menuChat=chatOf(event.target);
  },true);
  function workspaceMenu(node,x,y){
    document.getElementById('sx-workspace-menu')?.remove();
    const menu=api.el('div',{id:'sx-workspace-menu',class:'menu',popover:'auto',role:'menu'});
    const item=api.el('button',{class:'menu__item',role:'menuitem',onclick:()=>{openWorkspace(node);menu.hidePopover();}},'Открыть папку');menu.append(item);document.body.append(menu);
    menu.style.cssText=`position:fixed;margin:0;inset:auto;left:${Math.min(x,innerWidth-210)}px;top:${Math.min(y,innerHeight-64)}px;min-width:200px`;
    menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open'))menu.remove();});menu.showPopover();item.focus();
  }
  document.addEventListener('dragstart',event=>{const chat=chatOf(event.target);if(!chat)return;dragged=chat;event.dataTransfer.setData('application/x-strata-chat',chat);event.dataTransfer.effectAllowed='move';});
  document.addEventListener('dragover',event=>{if(dragged&&event.target.closest('.ws__row')){event.preventDefault();event.dataTransfer.dropEffect='move';event.target.closest('.ws__row').classList.add('sx-drop-target');}});
  document.addEventListener('dragleave',event=>event.target.closest?.('.ws__row')?.classList.remove('sx-drop-target'));
  document.addEventListener('dragend',()=>{dragged=null;document.querySelectorAll('.sx-drop-target').forEach(n=>n.classList.remove('sx-drop-target'));});
  document.addEventListener('drop',async event=>{
    const chat=dragged,workspace=workspaceOf(event.target);if(!chat||!workspace)return;event.preventDefault();dragged=null;document.querySelectorAll('.sx-drop-target').forEach(n=>n.classList.remove('sx-drop-target'));
    try{await run({action:'move',chat,workspaceId:workspace.id});}catch(error){notice(error);}
  });
  function scan(){
    if(!adapter())return;
    // Native "rewind" now stages an in-place edit. Keep its own click handler,
    // focus and disabled state; change only the obsolete label and glyph.
    for(const button of document.querySelectorAll('.st-msg--user button[aria-label="Вернуться сюда"], .st-msg--user button[aria-label="Rewind to here"]')){
      button.setAttribute('aria-label','Редактировать');button.title='Редактировать';
      const svg=button.querySelector('svg');
      if(svg){
        svg.setAttribute('viewBox','0 0 24 24');svg.style.transform='none';
        const pencil=document.createElementNS('http://www.w3.org/2000/svg','path');
        pencil.setAttribute('d','m16 3 5 5M3 21l5-1L21 7a2.1 2.1 0 0 0-5-5L3 15z');
        pencil.setAttribute('fill','none');pencil.setAttribute('stroke','currentColor');pencil.setAttribute('stroke-width','1.7');pencil.setAttribute('stroke-linejoin','round');svg.replaceChildren(pencil);
      }
    }
    for(const link of document.querySelectorAll('a.navsession'))link.draggable=true;
    for(const row of document.querySelectorAll('.ws__row'))if(!row.querySelector('[data-sx-folder-menu]'))row.append(api.el('button',{type:'button',class:'st-btn st-btn--icon','data-sx-folder-menu':'','aria-label':'Опции папки',onclick:event=>{const r=event.currentTarget.getBoundingClientRect();workspaceMenu(row,r.left,r.bottom);}},'⋯'));
    for(const menu of document.querySelectorAll('[role="menu"]')){
      if(!menuChat||menu.id==='sx-workspace-menu'||!/^(?:Действия для|Actions for)/u.test(menu.getAttribute('aria-label')??''))continue;
      const chat=menuChat;menuChat=null;menu.querySelector('[data-sx-open-chat]')?.remove();menu.dataset.sxChatMenu=chat;
      menu.append(api.el('button',{'data-sx-open-chat':'',class:'menu__item',role:'menuitem',onclick:async event=>{event.stopPropagation();try{await api.request('/chat-management',{action:'open-chat',chat});}catch(error){notice(error);}document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));}},'Открыть папку'));
    }
    const chat=adapter().get().activeSession,pending=staged.get(chat),composer=document.querySelector('.composer__inner'),old=document.getElementById('sx-editing-message');
    if(!pending||!composer){old?.remove();return;}
    if(old?.dataset.chat===chat)return;old?.remove();
    composer.prepend(api.el('div',{id:'sx-editing-message','data-chat':chat,class:'sx-editing-message'},'Редактирование: следующие сообщения и их материалы будут удалены после отправки.',api.el('button',{type:'button',class:'st-btn',onclick:()=>{staged.delete(chat);scan();}},'Отмена')));
  }
  return {scan};
}
