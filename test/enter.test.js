import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptOnEnter } from '../src/lib/enter.js';

function event(fields = {}) {
  return {
    key: 'Enter', inputType: 'insertLineBreak', cancelable: true,
    currentTarget: { value: 'Original text' }, defaultPrevented: false,
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
    ...fields,
  };
}

test('both SIP line-break input types accept without keydown and prevent the newline', () => {
  for (const inputType of ['insertParagraph', 'insertLineBreak']) {
    let accepted = 0;
    const enter = acceptOnEnter(() => accepted++);
    const input = event({ inputType });
    enter.onbeforeinput(input);
    assert.equal(input.defaultPrevented, true);
    assert.equal(accepted, 1);
  }
});

test('desktop Enter accepts, suppresses repeated presses and ignores non-Enter keys', () => {
  let accepted = 0;
  const enter = acceptOnEnter(() => accepted++);
  enter.onkeydown(event());
  enter.onkeydown(event({ repeat: true }));
  const normalKey = event({ key: 'a' });
  enter.onkeydown(normalKey);
  assert.equal(accepted, 1);
  assert.equal(normalKey.defaultPrevented, false);
});

test('keydown and beforeinput accept only once in either delivery order', () => {
  for (const order of [['onkeydown', 'onbeforeinput'], ['onbeforeinput', 'onkeydown']]) {
    let accepted = 0;
    const enter = acceptOnEnter(() => accepted++);
    for (const name of order) {
      const input = event();
      enter[name](input);
      assert.equal(input.defaultPrevented, true);
    }
    assert.equal(accepted, 1);
    enter.onkeyup(event());
    enter.onbeforeinput(event());
    assert.equal(accepted, 2);
  }
});

test('physical Shift+Enter allows a newline and sends it through the usual input handler', () => {
  let accepted = 0;
  let edited;
  const enter = acceptOnEnter(() => accepted++, input => { edited = input.currentTarget.value; });
  const key = event({ shiftKey: true });
  enter.onkeydown(key);
  const before = event();
  enter.onbeforeinput(before);
  enter.oninput(event({ currentTarget: { value: 'First\nSecond' } }));
  assert.equal(key.defaultPrevented, false);
  assert.equal(before.defaultPrevented, false);
  assert.equal(accepted, 0);
  assert.equal(edited, 'First\nSecond');
  enter.onkeyup(event());
  enter.onbeforeinput(event());
  assert.equal(accepted, 1);
});

test('active or flagged IME composition and key code 229 do not submit prematurely', () => {
  let accepted = 0;
  const enter = acceptOnEnter(() => accepted++);
  enter.oncompositionstart();
  const composing = event();
  enter.onbeforeinput(composing);
  enter.onkeydown(event());
  enter.oncompositionend();
  enter.onkeydown(event({ isComposing: true }));
  enter.onkeydown(event({ keyCode: 229 }));
  enter.onbeforeinput(event({ isComposing: true }));
  assert.equal(composing.defaultPrevented, false);
  assert.equal(accepted, 0);
  enter.onbeforeinput(event());
  assert.equal(accepted, 1);
});

test('non-cancellable SIP input restores the old text, including existing newlines, before acceptance', () => {
  let accepted;
  let edits = 0;
  const enter = acceptOnEnter(input => { accepted = input.currentTarget.value; }, () => edits++);
  const target = { value: 'First\nSecond' };
  enter.onbeforeinput(event({ cancelable: false, currentTarget: target }));
  assert.equal(accepted, undefined);
  target.value = 'First\n\nSecond';
  enter.oninput(event({ currentTarget: target }));
  assert.equal(accepted, 'First\nSecond');
  assert.equal(target.value, 'First\nSecond');
  assert.equal(edits, 0);
});

test('non-cancellable SIP fallback does not submit twice after an accepted keydown', () => {
  let accepted = 0;
  const enter = acceptOnEnter(() => accepted++);
  const target = { value: 'Original text' };
  enter.onkeydown(event({ currentTarget: target }));
  enter.onbeforeinput(event({ cancelable: false, currentTarget: target }));
  target.value += '\n';
  enter.oninput(event({ currentTarget: target }));
  assert.equal(accepted, 1);
  assert.equal(target.value, 'Original text');
});

test('pasted multiline text is preserved and not treated as Enter', () => {
  let accepted = 0;
  let edited;
  const enter = acceptOnEnter(() => accepted++, input => { edited = input.currentTarget.value; });
  const paste = event({ inputType: 'insertFromPaste', currentTarget: { value: 'Pasted\ntext' } });
  enter.onbeforeinput(paste);
  enter.oninput(paste);
  assert.equal(paste.defaultPrevented, false);
  assert.equal(accepted, 0);
  assert.equal(edited, 'Pasted\ntext');
});

test('a pending non-cancellable Enter cannot consume a later ordinary text input', () => {
  let accepted = 0;
  let edited;
  const enter = acceptOnEnter(() => accepted++, input => { edited = input.currentTarget.value; });
  enter.onbeforeinput(event({ cancelable: false }));
  enter.oninput(event({ inputType: 'insertText', currentTarget: { value: 'Original text changed' } }));
  assert.equal(accepted, 0);
  assert.equal(edited, 'Original text changed');
});