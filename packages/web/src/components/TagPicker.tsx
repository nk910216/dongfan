import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { zhTW } from '@dongfan/shared';
import type { StoredTag } from '../lib/db.js';

/**
 * Choosing the tags on a record, and adding one on the spot (spec 7.3).
 *
 * The list comes from the device, not from a request this component makes:
 * a form has to be usable with no signal, and the tags were synced with
 * everything else. **Making** one does need a connection, because the queue
 * takes event creations and nothing else (spec 6.1) -- a tag minted here
 * would carry an id the server never agreed to, and two phones inventing
 * one for the same word would make two tags. So the form offers what has
 * been synced and says plainly that a new one needs to be online.
 *
 * **A selected id this device has no tag for is drawn, and can be taken
 * off.** It is a tag deleted -- by the other parent, or here -- since the
 * record was written, and the server refuses it: `VALIDATION_FAILED`, not a
 * quiet drop. Leaving it selected is still right, because this device
 * cannot know it is gone until it syncs and silently editing what somebody
 * chose is worse than sending something that turns out not to exist. But it
 * used to have no chip at all, which made a queued record carrying one a
 * dead end: refused for good, and its correction form had nothing to tap to
 * remove the cause. Found in review.
 *
 * Removing it goes through `onChange` like any other choice, so the form's
 * own rules apply unchanged -- frozen while an outcome is unknown, and the
 * record keeps its id. What freezes it on the add form is the fieldset
 * around the fields and the form's `writable()`; the chip's own `disabled`
 * matches its neighbours but is not passed by any form today, so removing
 * it passes every test and it is not counted as the guard.
 */
export function TagPicker({ tags, selected, onChange, onCreate, disabled = false }: {
  tags: readonly StoredTag[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  onCreate: (name: string) => Promise<StoredTag | null>;
  disabled?: boolean;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * The props as they are *now*, for an answer that arrives later.
   *
   * Making a tag waits on the server, and the form does not stop while it
   * waits: somebody types a note, changes the amount, picks another tag.
   * The handler that pressed the button holds the props of that moment,
   * and `onChange` from that moment carries the whole form as it was then
   * -- so applying the new tag through it put the entire form back and
   * silently undid everything typed in between. Found in review.
   */
  const latest = useRef({ selected, onChange });
  useLayoutEffect(() => {
    latest.current = { selected, onChange };
  });

  /**
   * Whether this form is still on the screen.
   *
   * An answer that arrives after the form has been saved and left must do
   * nothing at all. Applied, it wrote the old content back as a draft, and
   * the next form opened holding this one's content.
   *
   * On the add form this overlaps with the form's own lock, which stays
   * shut once the record has been handed over. **The edit form has no such
   * lock**, so here this is the only thing between a late answer and a
   * ghost draft carrying the version it was written on -- and that is the
   * case its test exercises.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Chosen, with no tag on this device to show for it. */
  const missing = selected.filter((id) => !tags.some((tag) => tag.id === id));

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((one) => one !== id) : [...selected, id]);
  };

  const create = async (): Promise<void> => {
    const wanted = name.trim();
    if (wanted === '' || busy) return;

    setBusy(true);
    setFailed(false);
    const made = await onCreate(wanted);
    if (!mounted.current) return;
    setBusy(false);

    if (!made) {
      setFailed(true);
      return;
    }
    // Selected at once. Somebody who types a tag name into this form meant
    // to put it on this record, and making them tap it again is a step
    // that exists only because of how it was built.
    //
    // Merged into the selection and the form **as they are now**, not as
    // they were when the button was pressed.
    const now = latest.current;
    if (!now.selected.includes(made.id)) now.onChange([...now.selected, made.id]);
    setName('');
    setAdding(false);
  };

  return (
    <div className="mb-5" data-testid="tag-picker">
      <span className="mb-1.5 block text-[13px] text-ink-muted">{zhTW.addEvent.tags}</span>

      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => {
          const on = selected.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(tag.id)}
              aria-pressed={on}
              data-testid="tag-chip"
              data-tag-id={tag.id}
              className={`flex min-h-11 items-center gap-1 rounded-full border px-3 text-[13px] ${
                on
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-line bg-surface text-ink-muted'
              }`}
            >
              {on ? <Check size={13} aria-hidden /> : null}
              {tag.name}
            </button>
          );
        })}

        {missing.map((id) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(selected.filter((one) => one !== id))}
            aria-label={zhTW.addEvent.tagMissingRemove}
            data-testid="tag-missing"
            data-tag-id={id}
            className="flex min-h-11 items-center gap-1 rounded-full border border-dashed border-warn/70 px-3 text-[13px] text-warn-soft"
          >
            {zhTW.addEvent.tagMissing}
            <X size={13} aria-hidden />
          </button>
        ))}

        {tags.length === 0 && missing.length === 0 && !adding ? (
          <span className="text-[13px] text-ink-dim">{zhTW.addEvent.tagsEmpty}</span>
        ) : null}

        {adding ? null : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => { setAdding(true); setFailed(false); }}
            data-testid="add-tag"
            className="flex min-h-11 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[13px] text-ink-muted"
          >
            <Plus size={13} aria-hidden />
            {zhTW.addEvent.addTag}
          </button>
        )}
      </div>

      {adding ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            maxLength={30}
            disabled={disabled || busy}
            aria-label={zhTW.addEvent.tagName}
            data-testid="tag-name"
            onChange={(e) => { setName(e.target.value); setFailed(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void create(); }
            }}
            className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none"
          />
          <button
            type="button"
            disabled={disabled || busy || name.trim() === ''}
            onClick={() => void create()}
            data-testid="save-tag"
            className="min-h-11 rounded-xl border border-line px-3 text-[13px] text-accent disabled:opacity-50"
          >
            {zhTW.addEvent.save}
          </button>
          <button
            type="button"
            onClick={() => { setAdding(false); setName(''); setFailed(false); }}
            className="min-h-11 px-1 text-[13px] text-ink-dim"
          >
            {zhTW.addEvent.cancel}
          </button>
        </div>
      ) : null}

      {failed ? (
        <p className="mt-2 text-[12px] text-warn-soft" data-testid="tag-offline">
          {zhTW.addEvent.tagNeedsConnection}
        </p>
      ) : null}
    </div>
  );
}
