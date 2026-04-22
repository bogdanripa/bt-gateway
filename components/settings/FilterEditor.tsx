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

  // Prefetch markets + currencies when mode changes.
  useEffect(() => {
    let cancelled = false;
    setLookupErr(null);
    void (async () => {
      try {
        const [m, c] = await Promise.all([
          uiFetch<{ markets: Option[] }>(`/api/ui/lookup/markets?mode=${mode}`),
          uiFetch<{ currencies: Option[] }>(`/api/ui/lookup/currencies?mode=${mode}`),
        ]);
        if (cancelled) return;
        setMarkets(m.markets);
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
        hint="e.g. BVB — leave empty for no market restriction"
        options={markets}
        filter={filters.markets}
        onChange={(side, next) => setAxis('markets', side, next)}
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

let instrumentReqSeq = 0;
const instrumentDebounce: { t: ReturnType<typeof setTimeout> | null } = { t: null };

async function searchInstruments(mode: Mode, q: string): Promise<Option[]> {
  // Debounce 200 ms — BT's search tolerates this well.
  return new Promise<Option[]>((resolve) => {
    if (instrumentDebounce.t) clearTimeout(instrumentDebounce.t);
    const mySeq = ++instrumentReqSeq;
    instrumentDebounce.t = setTimeout(async () => {
      try {
        const res = await uiFetch<{ instruments: Option[] }>(
          `/api/ui/lookup/instruments?mode=${mode}&q=${encodeURIComponent(q)}`,
        );
        if (mySeq !== instrumentReqSeq) return; // a newer request superseded
        resolve(res.instruments);
      } catch {
        resolve([]);
      }
    }, 200);
  });
}

interface AxisRowProps {
  title: string;
  hint: string;
  options: Option[];
  filter: FilterAxis;
  onChange: (side: SideName, next: string[]) => void;
  onQueryChange?: (q: string) => void;
  live?: boolean;
}

function AxisRow({ title, hint, options, filter, onChange, onQueryChange, live }: AxisRowProps) {
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
        />
        <ChipPicker
          label="Out (denied)"
          placeholder={live ? 'Start typing…' : 'Pick or type…'}
          options={options}
          values={filter.exclude}
          onChange={(v) => onChange('exclude', v)}
          onQueryChange={onQueryChange}
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
}

let pickerSeq = 0;

function ChipPicker({ label, placeholder, options, values, onChange, onQueryChange }: ChipPickerProps) {
  const [text, setText] = useState('');
  const listId = useMemo(() => `picker-list-${++pickerSeq}`, []);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function commit(raw: string) {
    const v = raw.trim().toUpperCase();
    if (!v) return;
    if (values.some((x) => x.toUpperCase() === v)) { setText(''); return; }
    onChange([...values, v]);
    setText('');
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
      <datalist id={listId}>
        {visibleOptions.slice(0, 50).map((o) => (
          <option key={`${o.code}|${o.label}`} value={o.code}>{o.label}</option>
        ))}
      </datalist>
    </div>
  );
}
