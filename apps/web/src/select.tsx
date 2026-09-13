import React, { useEffect, useId, useRef, useState } from 'react';
export function Select({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.findIndex(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(id + '-' + active)?.scrollIntoView({ block: 'nearest' }); }, [open, active, id]);
  const choose = (index: number) => { if (options[index]) onChange(options[index].value); setOpen(false); trigger.current?.focus(); };
  return <div className="styled-select" ref={ref} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className={'select-trigger' + (open ? ' is-open' : '')} role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" aria-activedescendant={open ? id + '-' + active : undefined} disabled={disabled}
      onClick={() => { setActive(Math.max(0, selected)); setOpen(!open); }}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          if (!open) { setActive(Math.max(0, selected)); setOpen(true); return; }
          if (event.key === 'Enter' || event.key === ' ') choose(active);
          else setActive(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      }}><span>{options[selected]?.label || label}</span><span className="select-arrow" aria-hidden="true">⌄</span></button>
    {open && <div id={id} role="listbox" aria-label={label} className="select-menu">{options.map((option, index) => <div key={option.value} id={id + '-' + index} role="option" aria-selected={option.value === value} className={'select-option' + (index === active ? ' focused' : '')}
      onPointerDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}><span>{option.label}</span><span aria-hidden="true">{option.value === value ? '✓' : ''}</span></div>)}</div>}
  </div>;
}
