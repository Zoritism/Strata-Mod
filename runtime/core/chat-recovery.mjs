/** The server's explicit deletion markers outrank stale browser recovery.
 * Absence from the server alone is NOT deletion: preserve new/offline chats. */
export function excludeDeleted(recovered,deleted){
  const ids=new Set(Array.isArray(deleted)?deleted.filter(id=>typeof id==='string'):[]);
  return {...recovered,sessions:recovered.sessions.filter(s=>!ids.has(s.id)),ids:recovered.ids.filter(id=>!ids.has(id))};
}
