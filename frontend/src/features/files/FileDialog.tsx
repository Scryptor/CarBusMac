/** Диалог файлов: трейсы лежат в ./traces, списки (комментарии, передача, фильтры) — в
 * ./data/lists на маке. Можно выбрать файл, ввести имя для сохранения, загрузить файл с
 * компьютера и скачать выбранный. */
import { Download, Upload } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cmd } from "../../core/client";
import { fmtSize } from "../../core/format";
import type { FileInfo } from "../../core/types";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Fields";

export function validFileName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 120 && !n.startsWith(".") && !/[/\\\u0000-\u001f]/.test(n);
}

interface Props {
  mode: "open" | "save";
  kind: "traces" | "lists";
  title: string;
  defaultName?: string;
  /** варианты формата для сохранения (первый — по умолчанию) */
  formats?: { value: string; label: string }[];
  /** короткая форма для трейсов: .trc / .jsonl */
  withFormat?: boolean;
  /** показывать только файлы с этими расширениями */
  extensions?: string[];
  onPick: (name: string, format?: string) => void;
  onClose: () => void;
}

const TRACE_FORMATS = [
  { value: "trc", label: t.files.trc },
  { value: "jsonl", label: t.files.jsonl },
];

function fmtDate(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function FileDialog({ mode, kind, title, defaultName, formats, withFormat, extensions, onPick, onClose }: Props) {
  const fmts = formats ?? (withFormat ? TRACE_FORMATS : undefined);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(defaultName ?? "");
  const [format, setFormat] = useState(fmts?.[0]?.value ?? "");
  const [err, setErr] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    cmd<{ files: FileInfo[] }>("files_list", { kind })
      .then((d) => setFiles(extensions ? d.files.filter((f) => extensions.some((e) => f.name.toLowerCase().endsWith(e))) : d.files))
      .catch((e: Error) => setErr(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  const ok = () => {
    if (mode === "open") {
      if (!selected) {
        setErr("Выберите файл в списке");
        return;
      }
      onPick(selected);
      return;
    }
    if (!validFileName(name)) {
      setErr(t.files.badName);
      return;
    }
    onPick(name.trim(), fmts ? format : undefined);
  };

  const upload = async (file: File) => {
    try {
      const r = await fetch(`/api/files/${kind}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
      setSelected(file.name);
      setErr("");
      await refresh();
    } catch (e) {
      setErr(`Не удалось загрузить: ${(e as Error).message}`);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      onOk={ok}
      okLabel={mode === "open" ? t.tracer.open : t.common.save}
      width={640}
      footerLeft={
        <span class="file-actions">
          <button type="button" class="btn" onClick={() => uploadRef.current?.click()}>
            <Upload size={14} /> {t.files.upload}
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void upload(f);
            }}
          />
          {selected ? (
            <a class="btn" href={`/api/files/${kind}/${encodeURIComponent(selected)}`} download={selected}>
              <Download size={14} /> {t.files.download}
            </a>
          ) : null}
        </span>
      }
    >
      <div class="file-list" role="listbox" aria-label="Файлы">
        <div class="file-row head">
          <span>{t.files.name}</span>
          <span>{t.files.size}</span>
          <span>{t.files.date}</span>
        </div>
        {files.length === 0 ? <div class="file-empty muted">{t.files.empty}</div> : null}
        {files.map((f) => (
          <div
            class={"file-row" + (selected === f.name ? " sel" : "")}
            role="option"
            aria-selected={selected === f.name}
            onClick={() => {
              setSelected(f.name);
              setErr("");
              if (mode === "save") setName(f.name.replace(/\.[^.]+$/, ""));
            }}
            onDblClick={() => (mode === "open" ? onPick(f.name) : undefined)}
          >
            <span class="fname" title={f.name}>
              {f.name}
            </span>
            <span class="mono">{fmtSize(f.size)}</span>
            <span class="mono">{fmtDate(f.mtime)}</span>
          </div>
        ))}
      </div>
      {mode === "save" ? (
        <div class="form-grid">
          <label for="fd-name">{t.files.name}</label>
          <input
            id="fd-name"
            class={"inp" + (err ? " invalid" : "")}
            aria-label={t.files.name}
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
              setErr("");
            }}
          />
          {fmts ? (
            <>
              <label>{t.files.format}</label>
              <Select value={format} options={fmts} onChange={setFormat} label={t.files.format} />
            </>
          ) : null}
        </div>
      ) : null}
      <div class="err-line">{err}</div>
    </Dialog>
  );
}
