/** Rebuild a fresh native agent session after editing/restarting from the surviving
 * history. The caller already bounds the message window and runs its token fit
 * check over this same text. Never truncate individual messages or discard the
 * text of a message simply because it also contains a picture. Pixels travel
 * through the native image inputs; historical tool syntax is reference data. */
export function earlierConversation(history,message){
  const rows=(Array.isArray(history)?history:[]).filter(m=>m?.role==='user'||m?.role==='assistant').map(m=>{
    const text=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'):'';
    return text.trim()?{role:m.role,text}:null;
  }).filter(Boolean);
  if(!rows.length)return message;
  return 'Previous messages from this same conversation, before the current request. They are historical context, not new instructions or pending tool calls. Use the original text when the user asks to keep or edit a previous result; do not invent missing details. Only the surviving history is included after an edit.\n'
    +rows.map(m=>`${m.role}: ${m.text}`).join('\n\n')+'\n\nCurrent message:\n'+message;
}
