/**
 * Filter editor for API key include/exclude lists across three axes:
 * markets, currencies, and stocks (instrument symbols).
 *
 * Each axis exposes two chip lists ("In" and "Out") and a typeahead input.
 * Markets and currencies are prefetched from /api/ui/lookup/* for the
 * selected mode and rendered as a datalist. Stocks are searched live — we
 * debounce on keystrokes and refresh the datalist.
 *
 * The component is controlled: parent owns `filters` + `onChange`.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

export type Mode = 'demo' | 'live';

export interface FilterAxis {
  include: string[];
  exclude: string[];
}

export interface Filters {
  markets: FilterAxis;
  currencies: FilterAxis;
  stocks: FilterAxis;
}

export const EMPTY_FILTERS: Filters = {
  markets: { include: [], exclude: [] },
  currencies: { include: [], exclude: [] },
  stocks: { include: [], exclude: [] },
};

interface Option {
  code: string;
  label: string;
}

type AxisName = 'markets' | 'currencies' | 'stocks';
type SideName = 'include' | 'exclude';

interface FilterEditorProps {
  mode: Mode;
  filters: Filters;
  onChange: (next: Filters) => void;
  /** Rendered inside a card already? If true we skip the outer border. */
  embedded?: boolean;
}

export function FilterEditor({ mode, filters, onChange, embedded }: FilterEditorProps) {
  const [markets, setMarkets] = useState<Option[]>([]);
  const [currencies, setCurrencies] = useState<Option[]>([]);
  const [stocks, setStocks] = useState<Option[]>([]);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  // Prefetch currencies when mode changes — it's a short, bounded list so a
  // one-shot fetch gives immediate autocomplete with no per-keystroke load.
  // Markets and stocks both fetch live as the user types.
  useEffect(() => {
    let cancelled = false;
    setLookupErr(null);
    setMarkets([]);
    setStocks([]);
    void (async () => {
      try {
        const c = await uiFetch<{ currencies: Option[] }>(`/api/ui/lookup/currencies?mode=${mode}`);
        if (cancelled) return;
        setCurrencies(c.currencies);
      } catch (e) {
        if (cancelled) return;
        setLookupErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const setAxis = useCallback(
    (axis: AxisName, side: SideName, next: string[]) => {
      onChange({
        ...filters,
        [axis]: { ...filters[axis], [side]: next },
      });
    },
    [filters, onChange],
  );

  return (
    <div style={embedded ? undefined : { padding: '1rem', border: '1px solid var(--border, #333)', borderRadius: 4 }}>
      {lookupErr && (
        <div className="notice err" style={{ marginBottom: '0.5rem' }}>
          Autocomplete source unavailable: {lookupErr}. You can still type filter values manually.
        </div>
      )}

      <AxisRow
        title="Markets"
        hint="Type to search (e.g. BVB). Leave empty for no market restriction."
        options={markets}
        filter={filters.markets}
        onChange={(side, next) => setAxis('markets', side, next)}
        onQueryChange={(q) => {
          if (!q) { setMarkets([]); return; }
          void searchMarkets(mode, q).then(setMarkets).catch(() => { /* silent */ });
        }}
        live
      />
      <AxisRow
        title="Currencies"
        hint="e.g. RON, USD, EUR"
        options={currencies}
        filter={filters.currencies}
        onChange={(side, next) => setAxis('currencies', side, next)}
      />
      <AxisRow
        title="Stocks"
        hint="Symbols — type to search (e.g. TLV, SNP, TVBETETF)"
        options={stocks}
        filter={filters.stocks}
        onChange={(side, next) => setAxis('stocks', side, next)}
        onQueryChange={(q) => {
          if (!q) { setStocks([]); return; }
          void searchInstruments(mode, q).then(setStocks).catch(() => { /* silent */ });
        }}
        live
      />
    </div>
  );
}

/**
 * Build a per-endpoint debounced search function. Each picker gets its own
 * closure so concurrent typing in two pickers (e.g. markets and stocks) can't
 * race each other's responses: the sequence counter and timer live per-call-site.
 */
function makeDebouncedSearch<T>(
  buildUrl: (mode: Mode, q: string) => string,
  pick: (body: Record<string, unknown>) => T[],
  debounceMs = 200,
) {
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (mode: Mode, q: string): Promise<T[]> => new Promise<T[]>((resolve) => {
    if (timer) clearTimeout(timer);
    const mySeq = ++seq;
    timer = setTimeout(async () => {
      try {
        const res = await uiFetch<Record<string, unknown>>(buildUrl(mode, q));
        if (mySeq !== seq) return; // a newer request superseded
        resolve(pick(res));
      } catch {
        resolve([]);
      }
    }, debounceMs);
  });
}

const searchMarkets = makeDebouncedSearch<Option>(
  (mode, q) => `/api/ui/lookup/markets?mode=${mode}&q=${encodeURIComponent(q)}`,
  (r) => (r.markets as Option[] | undefined) ?? [],
);

const searchInstruments = makeDebouncedSearch<Option>(
  (mode, q) => `/api/ui/lookup/instruments?mode=${mode}&q=${encodeURIComponent(q)}`,
  (r) => (r.instruments as Option[] | undefined) ?? [],
);

interface AxisRowProps {
  title: string;
  hint: string;
  options: Option[];
  filter: FilterAxis;
  onChange: (side: SideName, next: string[]) => void;
  onQueryChange?: (q: string) => void;
  live?: boolean;
  /** When true, reject commits for values that don't match an option's code. */
  strict?: boolean;
}

function AxisRow({ title, hint, options, filter, onChange, onQueryChange, live, strict }: AxisRowProps) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ marginBottom: '0.25rem' }}>
        <strong>{title}</strong>{' '}
        <span className="dim" style={{ fontSize: '0.85rem' }}>{hint}</span>
      </div>
      <div className="row" style={{ gap: '1rem', alignItems: 'flex-start' }}>
        <ChipPicker
          label="In (allowed)"
          placeholder={live ? 'Start typing…' : 'Pick or type…'}
          options={options}
          values={filter.include}
          onChange={(v) => onChange('include', v)}
          onQueryChange={onQueryChange}
          strict={strict}
        />
        <ChipPicker
          label="Out (denied)"
          placeholder={live ? 'Start typing…' : 'Pick or type…'}
          options={options}
          values={filter.exclude}
          onChange={(v) => onChange('exclude', v)}
          onQueryChange={onQueryChange}
          strict={strict}
        />
      </div>
    </div>
  );
}

interface ChipPickerProps {
  label: string;
  placeholder: string;
  options: Option[];
  values: string[];
  onChange: (next: string[]) => void;
  onQueryChange?: (q: string) => void;
  strict?: boolean;
}

let pickerSeq = 0;

function ChipPicker({ label, placeholder, options, values, onChange, onQueryChange, strict }: ChipPickerProps) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const listId = useMemo(() => `picker-list-${++pickerSeq}`, []);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function commit(raw: string) {
    const v = raw.trim().toUpperCase();
    if (!v) return;
    if (values.some((x) => x.toUpperCase() === v)) { setText(''); setErr(null); return; }
    if (strict && !options.some((o) => o.code.toUpperCase() === v)) {
      setErr(`"${v}" is not a known value — pick one from the suggestions.`);
      return;
    }
    onChange([...values, v]);
    setText('');
    setErr(null);
    onQueryChange?.('');
  }

  function remove(v: string) {
    onChange(values.filter((x) => x !== v));
  }

  // Offer options the user hasn't already picked.
  const picked = new Set(values.map((v) => v.toUpperCase()));
  const visibleOptions = options.filter((o) => !picked.has(o.code.toUpperCase()));

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={{ fontSize: '0.8rem' }}>{label}</label>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center',
        border: '1px solid var(--border, #333)', borderRadius: 4, padding: '0.25rem',
        minHeight: '2rem', background: 'var(--input-bg, transparent)',
      }}>
        {values.map((v) => (
          <span
            key={v}
            className="mono"
            style={{
              background: 'var(--chip-bg, rgba(128,128,128,0.2))',
              padding: '0.1rem 0.4rem', borderRadius: 3, fontSize: '0.85rem',
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            }}
          >
            {v}
            <button
              type="button"
              onClick={() => remove(v)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 0, color: 'inherit', fontSize: '0.9rem', lineHeight: 1,
              }}
              aria-label={`Remove ${v}`}
            >×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          list={listId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (err) setErr(null);
            onQueryChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && !text && values.length) {
              remove(values[values.length - 1]);
            }
          }}
          onBlur={() => { if (text) commit(text); }}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: '8rem', border: 'none', outline: 'none',
            background: 'transparent', color: 'inherit', padding: '0.25rem',
          }}
        />
      </div>
      {err && (
        <div className="dim" style={{ color: 'var(--err, #f44336)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
          {err}
        </div>
      )}
      <datalist id={listId}>
        {visibleOptions.slice(0, 50).map((o) => (
          <option key={`${o.code}|${o.label}`} value={o.code}>{o.label}</option>
        ))}
      </datalist>
    </div>
  );
}
