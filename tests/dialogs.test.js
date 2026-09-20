const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { showPluginDialog } = require('../ps-copy-paste-guides/dialogs.js');

function host() {
  return {
    active: false,
    async executeAsModal(handler, options) {
      assert.equal(this.active, false);
      assert.equal(options.interactive, true);
      this.active = true;
      try { return await handler(); } finally { this.active = false; }
    }
  };
}

for (const [nativeResult, expected] of [['ok', 'ok'], ['cancel', 'cancel'], ['reasonCanceled', 'cancel'], [undefined, 'cancel']]) {
  test(`dialog settles and releases modal state: ${nativeResult}`, async () => {
    const core = host();
    let settle;
    let cleaned = false;
    const dialog = {
      uxpShowModal() {
        assert.equal(core.active, true);
        return new Promise(resolve => { settle = resolve; });
      },
      close() { cleaned = true; }
    };
    const result = showPluginDialog(dialog, core);
    assert.equal(core.active, true);
    assert.equal(cleaned, false);
    settle(nativeResult);
    assert.equal(await result, expected);
    assert.equal(core.active, false);
    assert.equal(cleaned, true);
  });
}

test('native dialog rejection reaches the caller and releases modal state', async () => {
  const core = host();
  const failure = new Error('Host refused dialog');
  let cleaned = false;
  await assert.rejects(showPluginDialog({
    uxpShowModal: () => Promise.reject(failure),
    close() { cleaned = true; }
  }, core), error => error === failure);
  assert.equal(core.active, false);
  assert.equal(cleaned, true);
});

test('focus failure does not abandon the native promise', async () => {
  const core = host();
  assert.equal(await showPluginDialog({
    uxpShowModal: () => Promise.resolve('ok'),
    close() {}
  }, core, () => { throw new Error('Cannot focus'); }), 'ok');
  assert.equal(core.active, false);
});

test('a failed dialog command releases the command lock for the next invocation', async () => {
  const core = host();
  const alerts = [];
  core.showAlert = async value => alerts.push(value);
  let registered;
  const context = vm.createContext({
    console: { error() {} },
    require(name) {
      if (name === './dialogs.js') return { showPluginDialog };
      if (name === 'uxp') return { entrypoints: { setup(value) { registered = value; } } };
      if (name === 'photoshop') return { app: {}, constants: {}, action: {}, core };
      throw new Error(name);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ps-copy-paste-guides/main.js'), 'utf8'), context);
  assert.equal(Object.keys(registered.commands).length, 8);
  let attempts = 0;
  context.handler = async () => {
    attempts += 1;
    return showPluginDialog({
      uxpShowModal() {
        if (attempts === 1) return Promise.reject(new Error('Host refused dialog'));
        return Promise.resolve('ok');
      },
      close() {}
    }, core);
  };
  const command = vm.runInContext('wrapCommandHandler("Test", handler)', context);
  await command();
  assert.equal(alerts.length, 1);
  assert.equal(await command(), 'ok');
  assert.equal(attempts, 2);
});
