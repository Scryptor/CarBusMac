/** Диалог файлов: трейсы лежат в ./traces, списки (комментарии, передача, фильтры) — в
 * ./data/lists на маке. Можно выбрать файл, ввести имя для сохранения, загрузить файл с
 * компьютера и скачать выбранный. Существующий файл заменяется только после вопроса. */
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

type Kind = "traces" | "lists";

/** Разрешённые расширения по виду файлов — как TRACE_EXT / LIST_EXT бэкенда. */
const KIND_EXTS: Record<Kind, string[]> = { traces: [".trc", ".jsonl"], lists: [".json", ".cmt", ".tsk"] };

/** Расширение имени, если оно из разрешённых (для диалога — `exts`, иначе для вида файлов),
 * иначе "" (точки внутри имени — «my trace v1.2», «поездка 20.10.2026» — расширением не считаются). */
function knownExt(name: string, kind: Kind, exts?: string[]): string {
  const lower = name.toLowerCase();
  return (exts ?? KIND_EXTS[kind]).find((e) => lower.endsWith(e)) ?? "";
}

/** Имя, под которым бэкенд сохранит файл: без разрешённого расширения он допишет расширение
 * формата («поездка 20.10.2026» → «поездка 20.10.2026.trc»). Бэкенд проверяет расширение по
 * виду списка (комментарии — .cmt/.json, задачи — .tsk/.json, фильтры — .json): `exts`. */
export function savedName(name: string, kind: Kind, defaultExt: string | undefined, exts?: string[]): string {
  const n = name.trim();
  return knownExt(n, kind, exts) || !defaultExt ? n : n + defaultExt;
}

interface Props {
  mode: "open" | "save";
  kind: Kind;
  title: string;
  defaultName?: string;
  /** варианты формата для сохранения (первый — по умолчанию; значение = расширение без точки) */
  formats?: { value: string; label: string }[];
  /** формат, выбранный при открытии (например, как у сохраняемого файла) */
  defaultFormat?: string;
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

export function FileDialog({ mode, kind, title, defaultName, formats, defaultFormat, withFormat, extensions, onPick, onClose }: Props) {
  const fmts = formats ?? (withFormat ? TRACE_FORMATS : undefined);
  /** все файлы вида — по ним проверяем, не заменит ли сохранение существующий */
  const [all, setAll] = useState<FileInfo[]>([]);
  const files = extensions ? all.filter((f) => extensions.some((e) => f.name.toLowerCase().endsWith(e))) : all;
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(defaultName ?? "");
  const [format, setFormat] = useState(
    fmts?.some((f) => f.value === defaultFormat) ? (defaultFormat as string) : fmts?.[0]?.value ?? "",
  );
  const [err, setErr] = useState("");
  /** вопрос «Заменить?» поверх диалога (общий confirmDialog закрыл бы этот диалог с введённым именем) */
  const [ask, setAsk] = useState<{ text: string; answer: (yes: boolean) => void } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    cmd<{ files: FileInfo[] }>("files_list", { kind })
      .then((d) => setAll(d.files ?? []))
      .catch((e: Error) => setErr(e.message));

  useEffect(() => {
    void refresh();
  }, []);

  // Фокус — на видимое поле: имя файла (сохранение) или список (открытие). Иначе автофокус
  // диалога выбирал скрытый <input type="file">, и Enter/Escape до диалога не доходили.
  // Так же — после вопроса «Заменить?».
  useEffect(() => {
    if (!ask) (mode === "save" ? nameRef.current : listRef.current)?.focus();
  }, [ask]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".file-row.sel")?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  /** Файла с таким именем нет — сразу `then`, есть — после «Да» на вопрос «Заменить?». */
  const unlessReplaceDeclined = (fname: string, then: () => void) => {
    if (!all.some((f) => f.name.toLowerCase() === fname.toLowerCase())) {
      then();
      return;
    }
    setAsk({
      text: t.files.replaceAsk(fname),
      answer: (yes) => {
        setAsk(null);
        if (yes) then();
      },
    });
  };

  const pick = (f: FileInfo) => {
    setSelected(f.name);
    setErr("");
    if (mode !== "save") return;
    // заменить выбранный файл: имя без расширения и его формат
    const ext = knownExt(f.name, kind, extensions);
    setName(ext ? f.name.slice(0, -ext.length) : f.name);
    const fmt = fmts?.find((x) => `.${x.value}` === ext);
    if (fmt) setFormat(fmt.value);
  };

  const ok = () => {
    if (mode === "open") {
      if (!selected) {
        setErr(t.files.pick);
        return;
      }
      onPick(selected);
      return;
    }
    if (!validFileName(name)) {
      setErr(t.files.badName);
      return;
    }
    const target = savedName(name, kind, fmts ? `.${format}` : extensions?.[0], extensions);
    unlessReplaceDeclined(target, () => onPick(name.trim(), fmts ? format : undefined));
  };

  const upload = async (file: File) => {
    try {
      const r = await fetch(`/api/files/${kind}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
      setSelected(file.name);
      setErr("");
      await refresh();
    } catch (e) {
      setErr(t.files.uploadFailed((e as Error).message));
    }
  };

  return (
    <>
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
                const input = e.target as HTMLInputElement;
                const f = input.files?.[0];
                input.value = ""; // тот же файл можно выбрать снова (например, после «Нет»)
                if (f) unlessReplaceDeclined(f.name, () => void upload(f));
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
        <div
          ref={listRef}
          class="file-list"
          role="listbox"
          aria-label={t.files.list}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // со списка Enter диалог сам не нажимает «Принять» — нажимаем здесь
              e.preventDefault();
              ok();
              return;
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            if (!files.length) return;
            const i = files.findIndex((f) => f.name === selected);
            pick(files[e.key === "ArrowDown" ? Math.min(files.length - 1, i + 1) : Math.max(0, i - 1)]);
          }}
        >
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
              onClick={() => pick(f)}
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
              ref={nameRef}
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
      {ask ? (
        <Dialog title={title} onClose={() => ask.answer(false)} onOk={() => ask.answer(true)} okLabel={t.common.yes} cancelLabel={t.common.no} width={440}>
          <p style={{ margin: 0 }}>{ask.text}</p>
        </Dialog>
      ) : null}
    </>
  );
}
