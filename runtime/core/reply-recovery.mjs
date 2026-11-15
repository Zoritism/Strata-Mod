/** Recover a truncated answer through the native compactor before admitting
 * another model request. Never replay a partial tool call or edit its payload.
 * All state belongs to the host turn; cancellation and retry counts stay native.
 */
export function replyRoom(context) {
  if (!Number.isFinite(context?.tokens) || context.tokens < 0 || !(context?.window > 0)) return null;
  // Match the native local reply reservation, plus framing/continuation room.
  const reserve = Math.max(4096, Math.min(32768, Math.floor(context.window * 0.3)));
  return context.window - context.tokens - reserve - 1024;
}

const failed = () => ({ok: false, message: 'Ответ оборвался. Не удалось освободить достаточно контекста для продолжения; повтор с почти нулевым лимитом остановлен. История сохранена. Сократите контекст командой /compact и повторите запрос.'});

/** One recovery transaction, called only while the native agent is idle.
 * A short cutoff can be caused by a server clamp invisible to the estimator;
 * force a compaction in that case as well. A failed/no-progress compaction is
 * not permission to spend the remaining token on another doomed continuation.
 */
export async function prepareReplyRetry({cut, context, compact, stopped = () => false, report = () => {}}) {
  const cancelled = () => ({ok: false, cancelled: true});
  if (stopped()) return cancelled();
  try {
    const before = await context();
    if (stopped()) return cancelled();
    const room = replyRoom(before);
    const shortCut = !(cut?.tokens >= Math.min(8192, (before?.window || 65536) / 8));
    if (room !== null && room >= 0 && !shortCut) return {ok: true, compacted: false};
    report('Освобождаю контекст перед продолжением ответа…');
    const result = await compact();
    if (stopped()) return cancelled();
    if (!result?.ok) return failed();
    const after = result.after ?? await context();
    if (stopped()) return cancelled();
    const remaining = replyRoom(after);
    if (remaining === null || remaining < 0 || (before && !(after.tokens < before.tokens))) return failed();
    return {ok: true, compacted: true, before, after};
  } catch {
    return stopped() ? cancelled() : failed();
  }
}

/** Disk advice is valid only for known file writers with an actual target.
 * A generic MCP operation is atomic: inspect its status, then issue a complete
 * valid call. Do not split JSON, shorten user content, or replay completed work.
 */
export function replyCutNudge({calls = []} = {}) {
  const fileWrites = calls.length > 0 && calls.every(call => /^(write|edit)$/.test(call.name) && call.target);
  if (fileWrites) return undefined; // Use the native file-specific instructions.
  if (!calls.length) return 'Your last reply reached the output limit. Continue the unfinished task without repeating completed work. Keep reasoning brief and finish the requested answer.';
  return 'Your last reply reached the output limit while composing a tool call. The incomplete call did NOT execute. Review the preceding tool results and any available operation status; do not repeat completed operations. Continue the unfinished task with complete, schema-valid tool calls. If the tool supports independent items, submit fewer items per call. Never split a single JSON argument across calls or shorten the requested content merely to fit. This is not necessarily a file operation: do not create, inspect or edit files unless the actual task requires it. Keep reasoning brief.';
}

/** Generic tool failures must not be described as failed writes to disk. */
export function replyCutNotice({calls = [], retrying = false, recoveryError} = {}) {
  if (recoveryError) return {text: recoveryError, values: []};
  if (!calls.length || calls.every(call => /^(write|edit)$/.test(call.name) && call.target)) return undefined;
  return {text: retrying
    ? 'Ответ достиг лимита во время подготовки команды инструмента. Незавершённая команда не выполнена. Контекст проверен; продолжаю оставшуюся работу.'
    : 'Ответ снова достиг лимита. Незавершённая команда инструмента не выполнена; уже выполненные действия сохранены. Автоматические повторы закончились.', values: []};
}
