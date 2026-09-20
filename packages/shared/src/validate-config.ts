import { EVENT_TYPES } from './event-types.js';
import type { EventTypeConfig } from './types.js';

/**
 * Invariants the event type table has to satisfy (spec 3.1).
 *
 * These run at module load rather than in a test so a malformed entry fails
 * immediately and loudly, on both the client and the worker, instead of
 * producing a subtly wrong chart weeks later.
 */
function violations(t: EventTypeConfig): string[] {
  const out: string[] = [];
  if (t.timerEnabled && !t.hasRange) out.push('timerEnabled requires hasRange');
  if (t.allDay && (t.hasRange || t.timerEnabled)) out.push('allDay excludes hasRange and timerEnabled');
  if (t.aggregation === 'duration_sum' && !t.hasRange) out.push('duration_sum requires hasRange');
  if (['sum', 'last', 'avg', 'max'].includes(t.aggregation) && t.value === null) {
    out.push(`aggregation ${t.aggregation} requires a value spec`);
  }
  if (t.valueRequired && t.value === null) out.push('valueRequired requires a value spec');
  if (t.value && t.value.min > t.value.max) out.push('value min exceeds max');
  if (t.value && t.value.scale < 1) out.push('value scale must be at least 1');
  return out;
}

export function assertEventTypesValid(types: readonly EventTypeConfig[] = EVENT_TYPES): void {
  const problems: string[] = [];

  const seenIds = new Set<string>();
  const seenOrder = new Set<string>();

  for (const t of types) {
    if (seenIds.has(t.id)) problems.push(`${t.id}: duplicate id`);
    seenIds.add(t.id);

    const orderKey = `${t.category}#${t.order}`;
    if (seenOrder.has(orderKey)) problems.push(`${t.id}: duplicate order ${t.order} in ${t.category}`);
    seenOrder.add(orderKey);

    for (const v of violations(t)) problems.push(`${t.id}: ${v}`);

    const seenFields = new Set<string>();
    for (const f of t.metadataFields ?? []) {
      if (seenFields.has(f.id)) problems.push(`${t.id}: duplicate metadata field ${f.id}`);
      seenFields.add(f.id);
      if (f.kind === 'enum' && f.options.length === 0) {
        problems.push(`${t.id}: enum ${f.id} has no options`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid event type config:\n  ${problems.join('\n  ')}`);
  }
}

assertEventTypesValid();
