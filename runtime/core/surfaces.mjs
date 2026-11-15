/** A backdrop click closes the dialog; clicks inside its form do not. */
export function dismissDialog(node,event){
  if(event.target!==node)return false;
  const r=node.getBoundingClientRect();
  const outside=event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;
  if(outside){node.close();return true;}
  return false;
}
