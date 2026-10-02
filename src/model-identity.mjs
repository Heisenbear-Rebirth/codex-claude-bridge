// Synthetic notices are transport messages, not a user's model selection.
export function knownModel(value) {
  return typeof value === 'string' && value.trim() && !/^<[^>]+>$/.test(value.trim()) ? value : null;
}
export function modelChanged(before, after) {
  return Boolean(knownModel(before) && knownModel(after) && before !== after);
}
