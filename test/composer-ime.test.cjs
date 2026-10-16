const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../demo/app.js'), 'utf8');

function composerHarness(inputId) {
  const calls = { submit: 0, mention: 0, focus: 0, render: 0 };
  const inputs = new Map();
  const timers = [];
  let now = 1000;
  const document = {
    activeElement: null,
    title: '',
    getElementById(id) { return id === 'app' ? root : inputs.get(id) || null; }
  };
  function field(id, tag = 'textarea', composer = true) {
    return {
      id, value: '中文草稿', name: '', dataset: {},
      selectionStart: 2, selectionEnd: 2,
      matches(selector) {
        if (selector === '.composer textarea') return composer && tag === 'textarea';
        if (selector === 'input, textarea') return tag === 'input' || tag === 'textarea';
        return false;
      },
      closest(selector) {
        return composer && selector === '.composer' ? {
          querySelector() { return { click() { calls.submit++; } }; }
        } : null;
      },
      focus() { calls.focus++; document.activeElement = this; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    };
  }
  class Root extends EventTarget {
    set innerHTML(html) {
      calls.render++;
      document.activeElement = null;
      inputs.clear();
      for (const id of ['home-input', 'thread-input']) {
        if (html.includes(`id="${id}"`)) { const input = field(id); const match = html.match(new RegExp(`<textarea id="${id}"[^>]*>([\\s\\S]*?)</textarea>`)); input.value = match?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') || ''; inputs.set(id, input); }
      }
    }
    querySelector(selector) {
      if (selector === '.mention-picker>button:not(:disabled)') {
        return { click() { calls.mention++; } };
      }
      return null;
    }
  }
  const root = new Root();
  class TestDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    document, window: {}, Date: TestDate,
    localStorage: { getItem: () => null, setItem() {} }, setTimeout(fn) { timers.push(fn); }
  });
  vm.runInContext(source, context);
  vm.runInContext(inputId === 'home-input'
    ? "state.homeMode='agent';render()"
    : "state.view='task';state.task='feedback';render()", context);
  const input = inputs.get(inputId);
  assert.ok(input, '实际页面应包含待测输入框');
  document.activeElement = input;
  input.value = '中文草稿';
  vm.runInContext(`state.composerDrafts['${inputId}']='中文草稿'`, context);
  Object.keys(calls).forEach(key => { calls[key] = 0; });
  function emit(type, properties = {}, target = input) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [name, value] of Object.entries({ target, ...properties })) {
      Object.defineProperty(event, name, { value });
    }
    root.dispatchEvent(event);
    return event;
  }
  return {
    input, document, calls, field, emit,
    key(properties = {}, target = input) {
      return emit('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, which: 13, ...properties }, target);
    },
    evaluate(code) { return vm.runInContext(code, context); },
    advance(ms) { now += ms; },
    current() { return inputs.get(inputId); },
    flushTimers() { for (const fn of timers.splice(0)) fn(); }
  };
}

function assertCandidateUntouched(harness, event) {
  assert.equal(event.defaultPrevented, false, '不阻止输入法默认候选操作');
  assert.deepEqual(harness.calls, { submit: 0, mention: 0, focus: 0, render: 0 });
  assert.equal(harness.document.activeElement, harness.input);
  assert.equal(harness.input.value, '中文草稿');
  assert.equal(harness.input.selectionStart, 2);
  assert.equal(harness.input.selectionEnd, 2);
}

for (const inputId of ['home-input', 'thread-input']) {
  test(`${inputId}：isComposing Enter 不提交、不选择 @`, () => {
    const h = composerHarness(inputId);
    h.evaluate(`state.mentionMenu=true;state.mentionInput='${inputId}'`);
    assertCandidateUntouched(h, h.key({ isComposing: true }));
  });

  for (const property of ['keyCode', 'which']) {
    test(`${inputId}：${property}=229 单独标识输入法候选键`, () => {
      const h = composerHarness(inputId);
      h.evaluate('state.mentionMenu=true');
      assertCandidateUntouched(h, h.key({ [property]: 229 }));
    });
  }

  test(`${inputId}：compositionstart 状态兜底，确认后第二次 Enter 正常提交`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    assertCandidateUntouched(h, h.key());
    h.emit('compositionend');
    const event = h.key();
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.calls.submit, 1, '标准事件顺序不应吞掉随后的正常 Enter');
  });

  for (const property of ['keyCode', 'which']) {
    test(`${inputId}：macOS compositionend + ${property}=229 后第二次 Enter 正常提交`, () => {
      const h = composerHarness(inputId);
      h.emit('compositionstart');
      h.emit('compositionend');
      assertCandidateUntouched(h, h.key({ [property]: 229 }));
      assert.equal(h.key().defaultPrevented, true);
      assert.equal(h.calls.submit, 1, '显式 229 确认已消耗保护窗口，不能再吞一次 Enter');
    });
  }

  test(`${inputId}：compositionend 先于无标记 Enter，短窗口只保护一次`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    h.emit('compositionend');
    assertCandidateUntouched(h, h.key());
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1, '即使第二次 Enter 同时刻触发也应正常提交');
  });

  test(`${inputId}：compositionend 短窗口过期，不吞正常 Enter`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    h.emit('compositionend');
    h.advance(200);
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });

  test(`${inputId}：Process/229 的 Enter 先于 compositionend，不误保护第二次 Enter`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    assertCandidateUntouched(h, h.key({ key: 'Process', code: 'Enter', keyCode: 229, which: 229 }));
    h.emit('compositionend');
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });

  test(`${inputId}：组合状态及短窗口的 Escape 不关闭 @菜单、不转移焦点`, () => {
    const h = composerHarness(inputId);
    h.evaluate(`state.mentionMenu=true;state.mentionInput='${inputId}'`);
    h.emit('compositionstart');
    assertCandidateUntouched(h, h.key({ key: 'Escape', keyCode: 27, which: 27 }));
    assert.equal(h.evaluate('state.mentionMenu'), true);
    h.emit('compositionend');
    assertCandidateUntouched(h, h.key({ key: 'Escape', keyCode: 229, which: 229 }));
    assert.equal(h.evaluate('state.mentionMenu'), true);
  });

  test(`${inputId}：ShiftEnter 保留换行默认行为，随后 Enter 正常提交`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    assertCandidateUntouched(h, h.key({ shiftKey: true, isComposing: true }));
    h.emit('compositionend');
    assertCandidateUntouched(h, h.key({ shiftKey: true }));
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });

  test(`${inputId}：无输入法状态的普通 Enter 和 ShiftEnter 行为不变`, () => {
    const h = composerHarness(inputId);
    assertCandidateUntouched(h, h.key({ shiftKey: true }));
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });

  test(`${inputId}：compositionend 同步已确认草稿，不改光标`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    h.input.value = '已确认中文';
    h.input.selectionStart = h.input.selectionEnd = 3;
    h.emit('compositionend');
    assert.equal(h.evaluate(`state.composerDrafts['${inputId}']`), '已确认中文');
    assert.equal(h.input.selectionStart, 3);
    assert.equal(h.input.selectionEnd, 3);
    assert.equal(h.calls.render, 0);
  });

  test(`${inputId}：保护状态只属于当前输入框`, () => {
    const h = composerHarness(inputId);
    const other = h.field('other-input', 'input', false);
    h.emit('compositionstart', {}, other);
    h.emit('compositionend', {}, other);
    assert.equal(h.key().defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });
}

test('非输入框不受 composition/229 保护干扰，普通 Enter 不触发提交', () => {
  const h = composerHarness('thread-input');
  const button = h.field('other-button', 'button', false);
  h.emit('compositionstart', {}, button);
  h.emit('compositionend', {}, button);
  assert.equal(h.key({ isComposing: true, keyCode: 229, which: 229 }, button).defaultPrevented, false);
  assert.equal(h.calls.submit, 0);
  h.evaluate('state.mentionMenu=true');
  h.document.activeElement = button;
  h.key({ key: 'Escape', keyCode: 27, which: 27 }, button);
  assert.equal(h.evaluate('state.mentionMenu'), false, '非输入框 Escape 保留原有快捷键行为');
  assert.equal(h.calls.focus, 1);
});

for (const inputId of ['home-input', 'thread-input']) {
  test(`${inputId}：后台刷新不销毁中文候选框，确认后延迟刷新保留草稿、光标和回车保护`, () => {
    const h = composerHarness(inputId);
    h.emit('compositionstart');
    h.input.value = '我想做ppt';
    h.input.selectionStart = h.input.selectionEnd = 6;
    h.evaluate('render()');
    assert.equal(h.calls.render, 0);
    assert.equal(h.current(), h.input);
    h.emit('compositionend');
    h.flushTimers();
    const restored = h.current();
    assert.notEqual(restored, h.input);
    assert.equal(restored.value, '我想做ppt');
    assert.equal(restored.selectionStart, 6);
    assert.equal(h.document.activeElement, restored);
    assert.equal(h.key({}, restored).defaultPrevented, false, '确认回车不能发送');
    assert.equal(h.calls.submit, 0);
    assert.equal(h.key({}, restored).defaultPrevented, true);
    assert.equal(h.calls.submit, 1);
  });
  test(`${inputId}：普通后台刷新保留输入焦点和选区`, () => {
    const h = composerHarness(inputId);
    h.input.selectionStart = 1; h.input.selectionEnd = 3;
    h.evaluate('render()');
    assert.equal(h.document.activeElement, h.current());
    assert.equal(h.current().selectionStart, 1);
    assert.equal(h.current().selectionEnd, 3);
  });
}

test('回复文件卡显示名字、所在资料和可打开按钮，外部文件名转义', () => {
  const h = composerHarness('thread-input');
  const html = h.evaluate(`replyFiles({workspace:'公共空间'},{artifactsWorkspace:'个人空间',artifacts:[{id:'doc-1',name:'示例演示文稿.pptx'},{id:'bad',name:'<script>bad</script>.pptx'}]})`);
  assert.match(html, /示例演示文稿\.pptx/);
  assert.match(html, /已存入个人空间资料/);
  assert.match(html, /data-action="open-document" data-id="doc-1">打开/);
  assert.ok(!html.includes('<script>'));
  assert.equal(h.evaluate('replyFiles({},{})'), '');
});

test('工作页普通 Enter 仍选择 @候选，不提交消息', () => {
  const h = composerHarness('thread-input');
  h.evaluate('state.mentionMenu=true');
  assert.equal(h.key().defaultPrevented, true);
  assert.equal(h.calls.mention, 1);
  assert.equal(h.calls.submit, 0);
});
