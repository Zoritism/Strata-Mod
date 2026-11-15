import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activate } from '../extensions/chat-rules/backend.mjs';

test('per-chat rules survive loading and are included only in their own requests', () => {
  const fixtureRoot=path.resolve('.work','tests');fs.mkdirSync(fixtureRoot,{recursive:true});
  const extensionData = fs.mkdtempSync(path.join(fixtureRoot, 'strata-chat-rules-'));
  try {
    const routes = new Map(); let hook;
    activate({ id: 'chat-rules', paths: { extensionData }, route: (method, route, fn) => routes.set(method + ' ' + route, fn), command: (name,fn)=>{if(name==='read')hook=fn;} });
    assert.deepEqual(routes.get('GET /rules')({ query: { chat: 'alpha' } }), { rules: '', updatedAt: null });
    const unchanged = { sessionId: 'beta', message: 'текущий вопрос' };
    assert.equal(hook('beta'),'');
    const saved = routes.get('POST /rules')({ body: { chat: 'alpha', rules: 'Отвечай кратко. Пиши по-русски.' } });
    assert.equal(saved.rules, 'Отвечай кратко. Пиши по-русски.');
    const alpha = hook('alpha');
    assert.equal(alpha,'Отвечай кратко. Пиши по-русски.');
    assert.equal(hook('beta'),'');
    const restartedRoutes = new Map();
    let restartedHook;
    activate({ id: 'chat-rules', paths: { extensionData }, route: (method, route, fn) => restartedRoutes.set(method + ' ' + route, fn), command: (name,fn)=>{if(name==='read')restartedHook=fn;} });
    assert.equal(restartedRoutes.get('GET /rules')({ query: { chat: 'alpha' } }).rules, 'Отвечай кратко. Пиши по-русски.');
    assert.match(restartedHook('alpha'), /Отвечай кратко/);
    assert.throws(() => routes.get('POST /rules')({ body: { chat: '../outside', rules: 'x' } }), /идентификатор/i);
    assert.throws(() => routes.get('POST /rules')({ body: { chat: 'alpha', rules: 'x'.repeat(12001) } }), /12000/);
    routes.get('POST /rules')({ body: { chat: 'alpha', rules: '' } });
    assert.equal(fs.existsSync(path.join(extensionData, 'chat-rules', 'chats', 'alpha.json')), false);
    assert.equal(hook('alpha'), '');
  } finally {
    fs.rmSync(extensionData, { recursive: true, force: true });
  }
});
