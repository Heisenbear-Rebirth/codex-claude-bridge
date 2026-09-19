const count = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

// Per-response counters, never Session.tokens (the session billing total).
export function openCodeUsage(session, messages, providers = []) {
  const rows = (Array.isArray(messages) ? messages : []).filter(row => row.info?.sessionID === session.id
    && (!session.revert?.messageID || row.info.id < session.revert.messageID))
    .sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0) || a.info.id.localeCompare(b.info.id));
  let selected, used;
  const summary = rows.findLast(row => row.info.role === 'assistant' && row.info.summary && row.info.time?.completed && row.info.finish && !row.info.error);
  const latestUser = rows.findLast(row => row.info.role === 'user');
  for (const row of rows) {
    if (row.info.role !== 'assistant' || row.info.summary || summary && rows.indexOf(row) <= rows.indexOf(summary)) continue;
    const t = row.info.tokens;
    // Native output already includes reasoning; match OpenCode's overflow basis.
    const fields = [t?.input, t?.output, t?.cache?.read, t?.cache?.write].map(count);
    const total = count(t?.total) > 0 ? t.total : fields.every(n => n !== null) ? fields.reduce((a, b) => a + b, 0) : null;
    // Native streaming placeholders contain zero counters before usage arrives.
    if (total > 0) { selected = row; used = total; }
  }
  if (!selected) return null;
  const info = selected.info;
  const model = providers.find(p => p.id === info.providerID)?.models?.[info.modelID];
  const capacity = count(model?.limit?.context);
  const measured = info.time?.completed || info.time?.created;
  const changed = rows.indexOf(selected) < rows.length - 1 || !info.time?.completed || info.summary === true
    || Boolean(session.revert) || Boolean(session.model && (session.model.id !== info.modelID || session.model.providerID !== info.providerID));
  return { client: 'opencode', sessionId: session.id, source: 'opencode-last-response-usage', available: true,
    model: info.providerID + '/' + info.modelID, usedTokens: used, contextWindowTokens: capacity > 0 ? capacity : null,
    usedPercent: capacity > 0 ? Math.round(used / capacity * 10000) / 100 : null,
    measuredAt: Number.isFinite(measured) ? new Date(measured).toISOString() : null,
    queriedAt: new Date().toISOString(), historyChangedAfterMeasurement: changed, freshness: 'last-recorded-response',
    nativeMessageId: info.id, contextEpoch: summary?.info.id || 'initial',
    maintenanceMeasurementValid: Boolean(latestUser && info.parentID === latestUser.info.id && !session.revert
      && (!session.model || (session.model.id || session.model.modelID) === info.modelID && session.model.providerID === info.providerID)),
    detail: '最近一次原生回复的 token 统计；容量取该回复实际模型的完整上下文窗口。' };
}
