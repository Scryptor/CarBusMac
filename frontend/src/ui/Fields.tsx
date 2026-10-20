/** Поля ввода: флажок, выпадающий список, поле с подписью и строка ячеек-байтов
 * (как 8 полей «Данные» в окне передачи десктопа). */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export function Check({ checked, onChange, label, disabled, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ComponentChildren;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label class="check" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Select<T extends string | number>({ value, options, onChange, width, disabled, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: number;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <select
      class="inp"
      aria-label={label}
      style={width ? { width: `${width}px` } : undefined}
      disabled={disabled}
      value={String(value)}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const opt = options.find((o) => String(o.value) === raw);
        if (opt) onChange(opt.value);
      }}
    >
      {options.map((o) => (
        <option value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

export function TextInput({ value, onChange, width, mono, invalid, placeholder, label, disabled, maxLength, onEnter }: {
  value: string;
  onChange: (v: string) => void;
  width?: number;
  mono?: boolean;
  invalid?: boolean;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  maxLength?: number;
  onEnter?: () => void;
}) {
  return (
    <input
      class={"inp" + (mono ? " mono" : "") + (invalid ? " invalid" : "")}
      style={width ? { width: `${width}px` } : undefined}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid ? "true" : undefined}
      disabled={disabled}
      maxLength={maxLength}
      spellcheck={false}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

export function Labeled({ label, children, stack }: { label: ComponentChildren; children: ComponentChildren; stack?: boolean }) {
  return (
    <label class={"field" + (stack ? " stack" : "")}>
      <span>{label}</span>
      {children}
    </label>
  );
}

const hex2 = (v: number | null) => (v == null ? "" : v.toString(16).toUpperCase().padStart(2, "0"));

/** Разбор вставки: «0A 0B 0C», «0A,0B», «0A0B0C». */
export function splitPastedBytes(text: string): number[] {
  const t = text.trim();
  const parts = /[\s,;:]/.test(t) ? t.split(/[\s,;:]+/) : t.match(/.{1,2}/g) ?? [];
  return parts.filter(Boolean).map((p) => {
    if (!/^[0-9a-f]{1,2}$/i.test(p)) throw new Error(p);
    return parseInt(p, 16);
  });
}

export function ByteCells({ count, value, onChange, allowEmpty, label, disabled, active }: {
  count: number;
  value: (number | null)[];
  onChange: (v: (number | null)[]) => void;
  allowEmpty?: boolean;
  label: string;
  disabled?: boolean;
  /** сколько ячеек активно (DLC); остальные заблокированы */
  active?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [texts, setTexts] = useState<string[]>(() => Array.from({ length: count }, (_, i) => hex2(value[i] ?? null)));
  useEffect(() => {
    setTexts(Array.from({ length: count }, (_, i) => hex2(value[i] ?? null)));
  }, [value.join(","), count]);

  const emit = (next: (number | null)[]) => onChange(next.slice(0, count));

  return (
    <span class="bytes" role="group" aria-label={label}>
      {Array.from({ length: count }, (_, i) => {
        const off = disabled || (active !== undefined && i >= active);
        return (
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            class="inp mono"
            aria-label={`${label} ${i}`}
            value={texts[i]}
            disabled={off}
            maxLength={2}
            spellcheck={false}
            placeholder={allowEmpty ? "--" : undefined}
            onInput={(e) => {
              const raw = (e.target as HTMLInputElement).value.replace(/[^0-9a-f]/gi, "").slice(0, 2).toUpperCase();
              const nt = texts.slice();
              nt[i] = raw;
              setTexts(nt);
              const next = Array.from({ length: count }, (_, k) => value[k] ?? null);
              next[i] = raw === "" ? (allowEmpty ? null : 0) : parseInt(raw, 16);
              emit(next);
              if (raw.length === 2) refs.current[i + 1]?.focus();
            }}
            onKeyDown={(e) => {
              const el = e.target as HTMLInputElement;
              if (e.key === "Backspace" && el.value === "" && i > 0) refs.current[i - 1]?.focus();
              if (e.key === "ArrowRight" && el.selectionStart === el.value.length) refs.current[i + 1]?.focus();
              if (e.key === "ArrowLeft" && el.selectionStart === 0) refs.current[i - 1]?.focus();
            }}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onPaste={(e) => {
              const text = e.clipboardData?.getData("text") ?? "";
              let bytes: number[];
              try {
                bytes = splitPastedBytes(text);
              } catch {
                return;
              }
              if (bytes.length < 2) return;
              e.preventDefault();
              const next = Array.from({ length: count }, (_, k) => value[k] ?? null);
              bytes.forEach((b, k) => {
                if (i + k < count) next[i + k] = b;
              });
              emit(next);
            }}
          />
        );
      })}
    </span>
  );
}
