import { useState } from 'react';
import { Check, Plus } from 'lucide-react';
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
 * A tag the other parent deleted while this form was open stays selected
 * and simply has no chip to show for it. It is sent anyway and the server
 * drops it, which is the honest order of events: this device cannot know
 * the tag is gone until it syncs, and silently editing what somebody chose
 * would be worse than sending something that turns out not to exist.
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

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((one) => one !== id) : [...selected, id]);
  };

  const create = async (): Promise<void> => {
    const wanted = name.trim();
    if (wanted === '' || busy) return;

    setBusy(true);
    setFailed(false);
    const made = await onCreate(wanted);
    setBusy(false);

    if (!made) {
      setFailed(true);
      return;
    }
    // Selected at once. Somebody who types a tag name into this form meant
    // to put it on this record, and making them tap it again is a step
    // that exists only because of how it was built.
    if (!selected.includes(made.id)) onChange([...selected, made.id]);
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

        {tags.length === 0 && !adding ? (
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
