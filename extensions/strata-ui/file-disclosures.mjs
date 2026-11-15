/** Add a disclosure without reparenting React-owned file cards. State is held
 * by the existing container, so ordinary streaming/polling keeps it open.
 * Actual message images and errors remain visible. No body text is retained. */
export function installFileDisclosures(api){
  const mounted=new WeakMap();
  return {dispose(){
    for(const block of document.querySelectorAll('.sx-files-collapsible')){
      mounted.get(block)?.remove();block.classList.remove('sx-files-collapsible','sx-files-open');
    }
  },scan(){
    for(const block of document.querySelectorAll('.deliverables')){
      let button=mounted.get(block);
      if(!button||!button.isConnected){
        button=api.button('',()=>{const open=block.classList.toggle('sx-files-open');button.setAttribute('aria-expanded',String(open));});
        button.classList.add('sx-files-disclosure');button.setAttribute('aria-expanded','false');block.prepend(button);mounted.set(block,button);block.classList.add('sx-files-collapsible');
      }
      const count=block.querySelectorAll('.file-card').length||[...block.children].filter(c=>c!==button).length;
      const text='Файлы и изменения · '+count;
      if(button.textContent!==text)button.textContent=text;
      if(block.querySelector('[role="alert"],.inline-error')){block.classList.add('sx-files-open');button.setAttribute('aria-expanded','true');}
    }
  }};
}
