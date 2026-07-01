// Tag editor: chips for the note's current tags plus a free-text input that
// suggests existing tags (union across all notebooks) and creates new ones.
// Enter or comma commits the typed tag; Backspace on an empty input removes
// the last chip. Pure controlled component — the parent owns the tag list.

import React, { useMemo, useRef, useState } from 'react';
import { s } from './styles';

interface Props {
  tags: string[];
  /** Existing tags across all notebooks, offered as suggestions. */
  suggestions: string[];
  onChange: (tags: string[]) => void;
}

const normalize = (raw: string) => raw.trim().replace(/\s+/g, ' ');

export default function TagPicker({ tags, suggestions, onChange }: Props) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const available = useMemo(() => {
    const lower = input.toLowerCase();
    return suggestions.filter(
      t => !tags.includes(t) && (!lower || t.toLowerCase().includes(lower)),
    );
  }, [suggestions, tags, input]);

  const addTag = (raw: string) => {
    const tag = normalize(raw);
    if (!tag) return;
    // Reuse an existing tag's casing when the same tag is typed differently.
    const canonical =
      tags.find(t => t.toLowerCase() === tag.toLowerCase()) ??
      suggestions.find(t => t.toLowerCase() === tag.toLowerCase()) ??
      tag;
    if (!tags.includes(canonical)) onChange([...tags, canonical]);
    setInput('');
  };

  const removeTag = (tag: string) => onChange(tags.filter(t => t !== tag));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const exactMatch = available.some(t => t.toLowerCase() === normalize(input).toLowerCase());
  const showCreate = normalize(input).length > 0 && !exactMatch;

  return (
    <div style={s.tagRow}>
      <span style={{ fontSize: 13, color: 'var(--ifm-color-emphasis-500)' }} aria-hidden>
        🏷
      </span>
      {tags.map(tag => (
        <span key={tag} style={s.tagChip}>
          {tag}
          <button
            onClick={() => removeTag(tag)}
            style={s.tagChipRemove}
            title={`Remove tag "${tag}"`}
            aria-label={`Remove tag "${tag}"`}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => {
          setInput(e.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          // Delay so a click on a suggestion lands before the list closes.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        placeholder={tags.length ? 'Add tag…' : 'Add tags…'}
        style={s.tagInput}
        aria-label="Add tag"
      />
      {open && (available.length > 0 || showCreate) && (
        <div style={s.tagSuggest} role="listbox">
          {available.slice(0, 12).map(tag => (
            <button
              key={tag}
              onMouseDown={e => e.preventDefault()}
              onClick={() => addTag(tag)}
              style={s.tagSuggestItem}
              className="tag-suggest-item"
            >
              {tag}
            </button>
          ))}
          {showCreate && (
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => addTag(input)}
              style={{ ...s.tagSuggestItem, fontStyle: 'italic' }}
              className="tag-suggest-item"
            >
              + Create “{normalize(input)}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}
