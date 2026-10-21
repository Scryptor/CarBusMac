/** Окно «Данные сообщения» (dlgFramesView + агрегатор уникальных данных десктопа):
 * все различные payload одного ID со счётчиком и периодом — видно, какие значения
 * сообщение вообще принимает. Обновляется раз в секунду. Как у десктопа, сверху кнопки
 * «Установить комментарий для выбранного сообщения (F4)» и «Копировать в TX-List»;
 * комментарий — сообщения (ID), он показан рядом с кнопками. */
import { ArrowDownToLine, MessageSquare, RefreshCw } from "lucide-preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { closeFloat, floats, openDialog, openFloat } from "../../app/ui";
import { runAction } from "../../core/actions";
import { cmd } from "../../core/client";
import { fmtAscii, fmtData, fmtId, fmtPeriod } from "../../core/format";
import { commentKey, pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { CommentDialog } from "./dialogs";
import { rowKey } from "./monitorModel";

export interface UniqueRow {
  data: string;
  count: number;
  period_ms: number | null;
  ts: number;
}

/** Выделенный в окне payload — его берёт «Копировать в TX-List» (Task 18). */
export const framesPick: { current: { ch: number; id: number; ext: boolean; data: string } | null } = { current: null };

/** Сообщение окна «Данные сообщения», в котором сейчас фокус: F4 там правит его комментарий. */
export function focusedFramesMessage(): { ch: number; id: number; ext: boolean } | null {
  if (typeof document === "undefined") return null;
  const el = document.activeElement?.closest<HTMLElement>("[data-frames-msg]");
  const m = el?.dataset.framesMsg?.split(":").map(Number);
  return m && m.length === 3 ? { ch: m[0], id: m[1], ext: m[2] === 1 } : null;
}

/** source: "monitor" — агрегатор живого монитора (нужен включённый агрегатор, обновление раз
 * в секунду); "stream" — по буферу потока (записанному или загруженному), по запросу. */
function FramesBody({ ch, id, ext, source }: { ch: number; id: number; ext: boolean; source: FramesSource }) {
  const stream = source === "stream";
  const enabled = stream || store.settings.value.aggregator;
  const rev = store.capture.value.rev;
  const [reload, setReload] = useState(0);
  const comment = store.comments.value[commentKey(id, ext)] ?? "";
  const [rows, setRows] = useState<UniqueRow[]>([]);
  const [picked, setPicked] = useState<UniqueRow | null>(null);
  const sel = useMemo(() => new Selection(), []);
  const msg = rowKey(ch, id, ext);
  const copyPicked = () => {
    if (!picked) return;
    framesPick.current = { ch, id, ext, data: picked.data };
    runAction("copyFrameToTx");
  };

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      cmd<{ rows: UniqueRow[] }>(stream ? "capture_frames" : "monitor_frames", { ch, id, ext })
        .then((d) => alive && setRows(d.rows))
        .catch(() => {});
    load();
    // буфер потока может быть на миллионы кадров — его пересчитываем по кнопке и при замене
    // буфера (rev), а не каждую секунду
    const timer = stream ? undefined : setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, stream, ch, id, ext, stream ? rev : 0, reload]);

  if (!enabled) {
    return (
      <div class="frames-off" data-frames-msg={msg}>
        <p>{t.frames.needAggregator}</p>
        <button
          type="button"
          class="btn primary"
          onClick={() => cmd("settings_set", { patch: { aggregator: true } }).catch((e: Error) => pushToast("error", e.message))}
        >
          {t.frames.enableAggregator}
        </button>
      </div>
    );
  }

  const columns: Column<UniqueRow>[] = [
    { key: "dlc", title: t.col.dlc, width: 48, align: "center", render: (r) => r.data.length / 2 },
    { key: "data", title: t.col.data, width: 222, render: (r) => fmtData(r.data).map((b) => <span class="byte">{b}</span>) },
    { key: "period", title: t.col.period, width: 92, align: "right", render: (r) => fmtPeriod(r.period_ms) },
    { key: "count", title: t.col.count, width: 84, align: "right", render: (r) => r.count },
    { key: "ascii", title: t.col.ascii, width: 90, render: (r) => fmtAscii(r.data) },
  ];

  return (
    <div class="frames" data-frames-msg={msg}>
      <div
        role="toolbar"
        aria-label={t.frames.tools}
        style={{ display: "flex", alignItems: "center", gap: "2px", padding: "2px 6px", borderBottom: "1px solid var(--line)" }}
      >
        <button
          type="button"
          class="toolbtn"
          aria-label={t.rxMenu.comment}
          title={t.frames.commentHint}
          onClick={() => openDialog(<CommentDialog id={id} ext={ext} />)}
        >
          <MessageSquare size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          class="toolbtn"
          aria-label={t.frames.copyToTx}
          title={t.frames.copyToTx}
          disabled={!picked}
          onClick={copyPicked}
        >
          <ArrowDownToLine size={18} strokeWidth={1.75} />
        </button>
        {stream ? (
          <button type="button" class="toolbtn" aria-label={t.frames.refresh} title={t.frames.refresh} onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={18} strokeWidth={1.75} />
          </button>
        ) : null}
        <span
          class="muted"
          title={comment || undefined}
          style={{ marginLeft: "6px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {comment ? t.frames.comment(comment) : ""}
        </span>
      </div>
      <div class="frames-grid">
        <VirtualGrid<UniqueRow>
          gridId="frames"
          ariaLabel={caption(ch, id, ext, source)}
          columns={columns}
          rowCount={rows.length}
          getRow={(i) => rows[i]}
          version={rows.length + (rows[0]?.count ?? 0)}
          selection={sel}
          onSelectionChange={() => {
            const r = sel.focus != null ? rows[sel.focus] ?? null : null;
            framesPick.current = r ? { ch, id, ext, data: r.data } : null;
            setPicked(r);
          }}
          onActivate={() => runAction("copyFrameToTx")}
          emptyText={t.frames.empty}
        />
      </div>
      <div class="frames-foot muted">{t.frames.rows(rows.length)}</div>
    </div>
  );
}

export type FramesSource = "monitor" | "stream";

function caption(ch: number, id: number, ext: boolean, source: FramesSource): string {
  const shown = fmtId(id, ext, store.settings.value.monitor_hex_ids);
  return source === "stream" ? t.frames.streamCaption(ch, shown) : t.frames.caption(ch, shown);
}

export function openFrames(ch: number, id: number, ext: boolean, source: FramesSource = "monitor"): void {
  const fkey = `frames:${source === "stream" ? "stream:" : ""}${rowKey(ch, id, ext)}`;
  if (floats.value.has(fkey)) return;
  const n = [...floats.value.keys()].filter((k) => k.startsWith("frames:")).length;
  openFloat(
    fkey,
    <FloatingWindow
      key={fkey}
      id={fkey}
      title={caption(ch, id, ext, source)}
      width={760}
      height={400}
      resizable
      initial={{ x: 120 + n * 28, y: 140 + n * 28 }}
      onClose={() => closeFloat(fkey)}
    >
      <FramesBody ch={ch} id={id} ext={ext} source={source} />
    </FloatingWindow>,
  );
}
