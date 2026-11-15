import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual boot code with isolated browser services. All chunks must use
// the canonical entry identity or native state becomes duplicated.
test('boot refreshes and imports the canonical native module exactly once', { skip: !vm.SourceTextModule }, async () => {
  const source = fs.readFileSync(new URL('../runtime/core/boot.mjs', import.meta.url), 'utf8');
  const calls = [];
  const entry = '/assets/index-test.js';
  const context = vm.createContext({
    document: { querySelector: () => ({ dataset: { strataApp: entry } }) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async url => {
      assert.equal(url, entry);
      assert.equal(calls.at(-1).options.cache, 'reload');
      calls.push({ imported: url });
      const native = new vm.SyntheticModule([], () => {}, { context });
      await native.link(() => {});
      await native.evaluate();
      return native;
    },
  });
  await module.link(() => new vm.SyntheticModule(['historyKey', 'mergeRecovered'], function () {
    this.setExport('historyKey', 'synthetic');
    this.setExport('mergeRecovered', () => []);
  }, { context }));
  await module.evaluate();
  assert.equal(calls.filter(call => call.imported).length, 1);
  assert.equal(calls.at(-2).url, entry);
});
