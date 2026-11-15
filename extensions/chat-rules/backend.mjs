import fs from 'node:fs';
import path from 'node:path';

const validChat = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const MAX_RULES = 12000;

/** Save and apply one reusable user instruction block per Strata conversation. */
export function activate(api) {
  const root = path.join(api.paths.extensionData, api.id, 'chats');

  /** Reject links before reading or writing so a chat ID cannot escape extension data. */
  function location(chat) {
    if (!validChat(chat)) throw new Error('Неверный идентификатор чата.');
    const file = api.chatData?.(chat,'rules.json')??path.join(root, chat + '.json');
    for (let current = path.dirname(file); current !== path.dirname(current); current = path.dirname(current)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Ссылки в папке правил не поддерживаются.');
    }
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Файл правил не должен быть ссылкой.');
    return file;
  }

  function read(chat) {
    const file = location(chat);
    if (!fs.existsSync(file)) return { rules: '', updatedAt: null };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.rules !== 'string' || value.rules.length > MAX_RULES) throw new Error('Файл правил чата повреждён или превышает допустимый размер.');
    return { rules: value.rules, updatedAt: value.updatedAt ?? null };
  }

  /** Replace the saved rules as a single UTF-8 JSON record; empty text clears them. */
  function write(chat, rules) {
    if (typeof rules !== 'string' || rules.length > MAX_RULES) throw new Error(`Введите не более ${MAX_RULES} символов.`);
    const file = location(chat), value = { rules, updatedAt: new Date().toISOString() };
    if (!rules.trim()) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { rules: '', updatedAt: null };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return value;
  }

  api.route('GET', '/rules', ({ query }) => read(query.chat));
  api.route('POST', '/rules', ({ body }) => write(body.chat, body.rules));

  // A dedicated system input is read per turn by the native and Harness bridges.
  api.command('read',chat=>read(chat).rules);
}
