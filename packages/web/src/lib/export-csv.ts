import {
  eventTypeName, formatValue, getEventType, metadataLabel, metadataOptionLabel, msToMinutes,
  toLocalInput, zhTW,
} from '@dongfan/shared';
import type { ExportDto, ExportEventDto } from '@dongfan/shared';

/**
 * The export as a spreadsheet (spec 5.9).
 *
 * Made here rather than by the API because every heading, type name, option
 * label and unit in it is interface copy, and the API never returns text for
 * a person to read (spec 13.1). It is made from the very document the JSON
 * file is, so the two cannot disagree.
 *
 * Four things a spreadsheet does to a careless CSV, each handled below:
 *
 * - **Chinese read as nonsense.** Excel guesses the encoding of a CSV with
 *   no byte-order mark, and guesses wrong. The file starts with one.
 * - **A comma, a quote or a line break inside a note** splits the record
 *   across cells or rows. Such fields are quoted, inner quotes doubled
 *   (RFC 4180), and lines end CRLF.
 * - **A note that starts with `=`** is run as a formula when the file is
 *   opened -- `=HYPERLINK(...)` in a shared file is the classic attack, and
 *   "-3 ml" a note can begin with innocently. Any field starting with `=`,
 *   `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`, which
 *   spreadsheets show as text. Applied to every field, not just the ones a
 *   person typed, so a field added later cannot forget it.
 * - **Times in the wrong zone.** They are written in the baby's timezone,
 *   from the stored instants, never the device's (spec 3.4).
 */

/** Written as an escape: the character itself is invisible in an editor. */
const BOM = '\uFEFF';
const NEWLINE = '\r\n';

/** Neutralises a field a spreadsheet would read as a formula. */
export function guardFormula(field: string): string {
  return /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
}

/** One field, guarded and then quoted if it has to be. */
export function csvField(raw: string): string {
  const field = guardFormula(raw);
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function clock(instant: number, timeZone: string): string {
  return toLocalInput(instant, timeZone).replace('T', ' ');
}

function row(event: ExportEventDto, tagNames: Map<string, string>, timeZone: string): string[] {
  const type = getEventType(event.typeId);
  const spec = type?.value ?? null;
  const allDay = type?.allDay === true;

  const details = Object.entries(event.metadata)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${metadataLabel(key)}${zhTW.exportCsv.detailSeparator}${metadataOptionLabel(key, value)}`)
    .join(zhTW.exportCsv.listSeparator);

  const tags = event.tagIds
    .map((id) => tagNames.get(id))
    .filter((name): name is string => name !== undefined)
    .join(zhTW.exportCsv.listSeparator);

  return [
    event.localDate,
    allDay ? '' : clock(event.startedAt, timeZone),
    event.endedAt === null || allDay ? '' : clock(event.endedAt, timeZone),
    eventTypeName(event.typeId),
    spec ? formatValue(event.value, spec) : '',
    spec ? spec.unit : '',
    event.endedAt === null || allDay ? '' : String(msToMinutes(event.endedAt - event.startedAt)),
    details,
    tags,
    event.note,
    event.id,
  ];
}

export function toCsv(document: ExportDto): string {
  const h = zhTW.exportCsv;
  const header = [
    h.date, h.startedAt, h.endedAt, h.type, h.value, h.unit, h.minutes, h.details, h.tags, h.note, h.id,
  ];
  const tagNames = new Map(document.tags.map((tag) => [tag.id, tag.name]));
  const lines = [header, ...document.events.map((event) => row(event, tagNames, document.baby.timezone))]
    .map((fields) => fields.map(csvField).join(','));
  return BOM + lines.join(NEWLINE) + NEWLINE;
}
