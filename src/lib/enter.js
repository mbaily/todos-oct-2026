// SIP keyboards may report Enter as beforeinput without any usable keydown.
export function acceptOnEnter(accept, onInput = () => {}) {
  let composing = false;
  let shiftEnter = false;
  let acceptedBy = null;
  let pendingEnter = null;

  return {
    onkeydown(event) {
      shiftEnter = event.key === 'Enter' && event.shiftKey;
      if (event.key !== 'Enter') { acceptedBy = null; return; }
      if (shiftEnter || composing || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (acceptedBy === 'beforeinput') { acceptedBy = null; return; }
      acceptedBy = 'keydown';
      if (!event.repeat) accept(event);
    },
    onbeforeinput(event) {
      if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType) || composing || event.isComposing) return;
      if (shiftEnter) { shiftEnter = false; return; }
      const alreadyAccepted = acceptedBy === 'keydown';
      acceptedBy = null;
      if (!event.cancelable) {
        pendingEnter = { value: event.currentTarget.value, alreadyAccepted };
        return;
      }
      event.preventDefault();
      acceptedBy = 'beforeinput';
      if (!alreadyAccepted) accept(event);
    },
    oninput(event) {
      const pending = pendingEnter;
      pendingEnter = null;
      if (pending && ['insertParagraph', 'insertLineBreak'].includes(event.inputType) && !composing && !event.isComposing) {
        // Restore only the SIP's uncancellable newline, not pasted line breaks.
        event.currentTarget.value = pending.value;
        acceptedBy = 'beforeinput';
        if (!pending.alreadyAccepted) accept(event);
        return;
      }
      acceptedBy = null;
      onInput(event);
    },
    onkeyup(event) {
      if (event.key === 'Enter') { shiftEnter = false; acceptedBy = null; }
    },
    oncompositionstart() {
      composing = true;
      shiftEnter = false;
      acceptedBy = null;
      pendingEnter = null;
    },
    oncompositionend() { composing = false; },
  };
}