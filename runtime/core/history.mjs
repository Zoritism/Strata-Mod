import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, atomicJSON } from './storage.mjs';
export function createHistory(home) {
  const index = path.join(home, 'data', 'history-recovery.json');
  const location = () => { const m = readJSON(index, null); if (!m || !/^\d{4}-\d{2}$/.test(m.period)) return null; return path.join(home, 'data', 'recovery', m.period); };
  return {
    get() { const dir = location(); if (!dir) return {}; const applied = readJSON(path.join(dir, 'applied.json'), null); return applied ? { plan: { id: applied.id }, applied: true } : { plan: readJSON(path.join(dir, 'plan.json')), applied: false }; },
    write(action, value) {
      const dir = location(), plan = dir && readJSON(path.join(dir, 'plan.json'));
      if (!plan || value.id !== plan.id) throw Error('План восстановления изменился.');
      if (action === 'backup') {
        const file = path.join(dir, 'before.json');
        if (value.before !== null && (typeof value.before !== 'string' || !Array.isArray(JSON.parse(value.before)))) throw Error('Неверная резервная копия.');
        if (!fs.existsSync(file)) atomicJSON(file, { id: plan.id, value: value.before, at: new Date().toISOString() });
      } else if (action === 'applied') {
        if (!fs.existsSync(path.join(dir, 'before.json'))) throw Error('Нет резервной копии.');
        const sessions = JSON.parse(value.value), before = JSON.parse(readJSON(path.join(dir, 'before.json')).value ?? '[]');
        for (const s of before) if (!sessions.some(x => JSON.stringify(x) === JSON.stringify(s))) throw Error('Изменён существующий чат.');
        for (const s of plan.sessions) if (!before.some(x => x.id === s.id) && !sessions.some(x => JSON.stringify(x) === JSON.stringify(s))) throw Error('Не все восстановленные поля сохранены.');
        atomicJSON(path.join(dir, 'applied.json'), { id: plan.id, at: new Date().toISOString(), sha256: createHash('sha256').update(value.value).digest('hex'), sessions: sessions.map(s => ({ id: s.id, messages: s.messages.length, updatedAt: s.updatedAt })) });
      } else throw Error('Неизвестное действие.');
      return { ok: true };
    },
  };
}
