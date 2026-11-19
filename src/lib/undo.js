export const UNDO_LIMIT = 50;

// Only adjacent saves from the same editor session share an undo step.
// An intervening edit or checkbox change keeps its chronological position.
export function recordUndo(history, inverse, group = null) {
  if (!inverse) return history;
  const previous = history.at(-1);
  if (group && previous?.group === group && previous.action === 'update'
      && inverse.action === 'update' && previous.id === inverse.id) {
    return [...history.slice(0, -1), {
      ...inverse, group, fields: { ...inverse.fields, ...previous.fields },
    }];
  }
  return [...history, { ...inverse, group }].slice(-UNDO_LIMIT);
}
