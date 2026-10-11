import { describe, expect, it } from 'vitest';
import { eventTypeName, metadataLabel, metadataOptionLabel, zhTW } from '@dongfan/shared';
import type { ExportDto, ExportEventDto } from '@dongfan/shared';
import { csvField, guardFormula, toCsv } from '../src/lib/export-csv.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * The export as a spreadsheet (spec 5.9).
 *
 * Everything that goes wrong here goes wrong silently, in somebody else's
 * program: Chinese turned to nonsense by a missing byte-order mark, a note
 * with a comma split across two cells, a note starting with "=" run as a
 * formula. So the tests read the text that would be saved.
 */

/** 10 October 2026, 08:30 in Taipei. */
const AT = Date.UTC(2026, 9, 10, 0, 30);
const MINUTE = 60_000;

function event(partial: Partial<ExportEventDto> & { typeId: string }): ExportEventDto {
  return {
    id: 'event-1', startedAt: AT, endedAt: null, localDate: '2026-10-10', value: 1, note: '',
    metadata: {}, active: false, tagIds: [], createdBy: 'user-1', createdAt: AT, updatedAt: AT,
    ...partial,
  };
}

function document(events: ExportEventDto[], tags: ExportDto['tags'] = []): ExportDto {
  return {
    format: 'dongfan-export', formatVersion: 1, exportedAt: AT,
    baby: { id: 'baby-1', nickname: USER_CONTENT.nickname, gender: 'other', birthDate: '2026-03-08', timezone: 'Asia/Taipei' },
    types: {}, tags, eventCount: events.length, events,
  };
}

/** The rows of a CSV, split the simple way: only for fixtures with no quoted line breaks. */
function rows(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line !== '');
}

describe('the file', () => {
  it('starts with a byte-order mark, so a spreadsheet reads the Chinese', () => {
    expect(toCsv(document([])).startsWith('\uFEFF')).toBe(true);
  });

  it('ends every line with CRLF, the header included', () => {
    const csv = toCsv(document([event({ typeId: 'diaper' })]));
    expect(csv.replace(/^\uFEFF/, '').split('\r\n')).toHaveLength(3);
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('names its columns from the copy file, in order', () => {
    const h = zhTW.exportCsv;
    expect(rows(toCsv(document([])))[0]).toBe(
      [h.date, h.startedAt, h.endedAt, h.type, h.value, h.unit, h.minutes, h.details, h.tags, h.note, h.id].join(','),
    );
  });

  it('has a row for every record, in the order it was given', () => {
    const csv = toCsv(document([
      event({ id: 'a', typeId: 'diaper' }),
      event({ id: 'b', typeId: 'diaper', startedAt: AT + MINUTE }),
      event({ id: 'c', typeId: 'diaper', startedAt: AT + 2 * MINUTE }),
    ]));
    expect(rows(csv).slice(1).map((line) => line.split(',').at(-1))).toEqual(['a', 'b', 'c']);
  });
});

describe('a row', () => {
  it('reads a bottle the way the app does', () => {
    const line = rows(toCsv(document([event({ typeId: 'bottle', value: 120 })])))[1];
    expect(line?.split(',')).toEqual([
      '2026-10-10', '2026-10-10 08:30', '', eventTypeName('bottle'), '120', 'ml', '', '', '', '', 'event-1',
    ]);
  });

  it('writes a temperature in degrees, not the tenths it is stored in', () => {
    const fields = rows(toCsv(document([event({ typeId: 'temperature', value: 385 })])))[1]?.split(',');
    expect(fields?.[4]).toBe('38.5');
    expect(fields?.[5]).toBe('°C');
  });

  it('gives a finished range its end and its minutes, in the baby’s timezone', () => {
    // 23:10 to 06:40 the next morning: across midnight, in Taipei.
    const startedAt = Date.UTC(2026, 9, 9, 15, 10);
    const fields = rows(toCsv(document([
      event({ typeId: 'sleep', startedAt, endedAt: startedAt + 450 * MINUTE, localDate: '2026-10-09' }),
    ])))[1]?.split(',');
    expect(fields?.slice(0, 3)).toEqual(['2026-10-09', '2026-10-09 23:10', '2026-10-10 06:40']);
    expect(fields?.[6]).toBe('450');
  });

  it('leaves a running timer without an end or a length', () => {
    const fields = rows(toCsv(document([event({ typeId: 'sleep', active: true })])))[1]?.split(',');
    expect(fields?.[2]).toBe('');
    expect(fields?.[6]).toBe('');
  });

  it('spells out its details and names its tags', () => {
    const fields = rows(toCsv(document(
      [event({ typeId: 'diaper', metadata: { diaper_kind: 'pee' }, tagIds: ['t1', 't2', 'gone'] })],
      [{ id: 't1', name: USER_CONTENT.tag, createdAt: AT }, { id: 't2', name: 'daytime', createdAt: AT }],
    )))[1]?.split(',');
    expect(fields?.[7]).toBe(`${metadataLabel('diaper_kind')}${zhTW.exportCsv.detailSeparator}${metadataOptionLabel('diaper_kind', 'pee')}`);
    // A tag that is not in the file's tag list is left out, not printed as an id.
    expect(fields?.[8]).toBe(`${USER_CONTENT.tag}${zhTW.exportCsv.listSeparator}daytime`);
  });

  it('keeps a Chinese note exactly as it was typed', () => {
    const fields = rows(toCsv(document([event({ typeId: 'diaper', note: USER_CONTENT.note })])))[1]?.split(',');
    expect(fields?.[9]).toBe(USER_CONTENT.note);
  });
});

describe('a field', () => {
  it('quotes a comma, a quote and a line break, doubling the quote', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
    expect(csvField(USER_CONTENT.note)).toBe(USER_CONTENT.note);
  });

  it('keeps a note with a line break in one cell of one row', () => {
    const csv = toCsv(document([event({ typeId: 'diaper', note: 'first\nsecond, third' })]));
    expect(csv).toContain('"first\nsecond, third"');
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])('neutralises a field starting with %j', (start) => {
    // `=HYPERLINK(...)` in a note would run when the file is opened.
    expect(guardFormula(`${start}1+2`)).toBe(`'${start}1+2`);
  });

  it('leaves an ordinary field alone, and an equals sign that is not first', () => {
    expect(guardFormula('120')).toBe('120');
    expect(guardFormula('a=b')).toBe('a=b');
    expect(guardFormula(USER_CONTENT.note)).toBe(USER_CONTENT.note);
  });

  it('guards before it quotes, so the quote cannot hide the formula', () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it('guards a note and a tag name inside the file', () => {
    const csv = toCsv(document(
      [event({ typeId: 'diaper', note: '=1+1', tagIds: ['t'] })],
      [{ id: 't', name: '@SUM(A1)', createdAt: AT }],
    ));
    const fields = rows(csv)[1]?.split(',');
    expect(fields?.[8]).toBe("'@SUM(A1)");
    expect(fields?.[9]).toBe("'=1+1");
  });
});
