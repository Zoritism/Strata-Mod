export const historyKey = 'strata.sessions.v1';
export function normalizeRecoveredTitles(sessions) {
  return sessions.map(s => {
    if (!s.recovery || !s.title?.startsWith('Earlier in this conversation, before') || !s.title.endsWith(' · восстановлено')) return s;
    const context = s.messages.find(m => m.role === 'system')?.content ?? '';
    const text = context.match(/^user: (.+)$/m)?.[1] ?? s.messages.find(m => m.role === 'user')?.content ?? 'Разговор';
    return { ...s, title: text.replace(/\s+/g, ' ').slice(0, 65) + ' · ветка · восстановлено' };
  });
}
export function mergeRecovered(current, recovered) {
  if (!Array.isArray(current) || !Array.isArray(recovered)) throw Error('Неверный формат истории.');
  const ids = new Set(current.map(s => s.id));
  for (const s of recovered) {
    if (!s || typeof s.id !== 'string' || typeof s.workspace !== 'string' || !Array.isArray(s.messages)) throw Error('Повреждённый восстановленный чат.');
    if (!ids.has(s.id)) { current = [...current, s]; ids.add(s.id); }
  }
  return current;
}
