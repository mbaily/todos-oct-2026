export const UNDO_LIMIT = 50;

export function recordUndo(history, inverse) {
  return inverse ? [...history, inverse].slice(-UNDO_LIMIT) : history;
}
