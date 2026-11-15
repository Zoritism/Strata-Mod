import {registerHooks} from 'node:module';

// dsh-mcp-client 0.2.1-alpha.3 overflows V8's regexp stack on large PNGs.
// Keep this compatibility transformation outside the installed dependency.
// decodeImage's canonical decode/re-encode check remains authoritative.
const original = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;';
const replacement = 'const CANONICAL_BASE64 = { test: value => typeof value === "string" && value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) };';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/@deepseek-ai/dsh-mcp-client/lib/index.js') || result.source == null) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    if (source.split(original).length !== 2) return result;
    return {...result, source: source.replace(original, replacement)};
  },
});
