/** Окно «Данные сообщения» (dlgFramesView + агрегатор уникальных данных десктопа):
 * все различные payload одного ID со счётчиком и периодом — видно, какие значения
 * сообщение вообще принимает. Обновляется раз в секунду. */
import { useEffect, useMemo, useState } from "preact/hooks";
import { closeFloat, floats, openFloat } from "../../app/ui";
import { runAction } from "../../core/actions";
import { cmd } from "../../core/client";
import { fmtAscii, fmtData, fmtId, fmtPeriod } from "../../core/format";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { rowKey } from "./monitorModel";

export interface UniqueRow {
  data: string;
  count: number;
  period_ms: number | null;
  ts: number;
}

/** Выделенный в окне payload — его берёт «Копировать в TX-List» (Task 18). */
export const framesPick: { current: { ch: number; id: number; ext: boolean; data: string } | null } = { current: null };

function FramesBody({ ch, id, ext }: { ch: number; id: number; ext: boolean }) {
  const enabled = store.settings.value.aggregator;
  const [rows, setRows] = useState<UniqueRow[]>([]);
  const sel = useMemo(() => new Selection(), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      cmd<{ rows: UniqueRow[] }>("monitor_frames", { ch, id, ext })
        .then((d) => alive && setRows(d.rows))
        .catch(() => {});
    load();
    const timer = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, ch, id, ext]);

  if (!enabled) {
    return (
      <div class="frames-off">
        <p>{t.frames.needAggregator}</p>
        <button
          type="button"
          class="btn primary"
          onClick={() => cmd("settings_set", { patch: { aggregator: true } }).catch((e: Error) => pushToast("error", e.message))}
        >
          Включить агрегатор
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
    <div class="frames">
      <div class="frames-grid">
        <VirtualGrid<UniqueRow>
          gridId="frames"
          ariaLabel={t.frames.caption(ch, fmtId(id, ext, true))}
          columns={columns}
          rowCount={rows.length}
          getRow={(i) => rows[i]}
          version={rows.length + (rows[0]?.count ?? 0)}
          selection={sel}
          onSelectionChange={() => {
            const r = sel.focus != null ? rows[sel.focus] : null;
            framesPick.current = r ? { ch, id, ext, data: r.data } : null;
          }}
          onActivate={() => runAction("copyFrameToTx")}
          emptyText="Пока нет данных"
        />
      </div>
      <div class="frames-foot muted">{t.frames.rows(rows.length)}</div>
    </div>
  );
}

export function openFrames(ch: number, id: number, ext: boolean): void {
  const fkey = `frames:${rowKey(ch, id, ext)}`;
  if (floats.value.has(fkey)) return;
  const n = [...floats.value.keys()].filter((k) => k.startsWith("frames:")).length;
  openFloat(
    fkey,
    <FloatingWindow
      key={fkey}
      id={fkey}
      title={t.frames.caption(ch, fmtId(id, ext, true))}
      width={600}
      height={360}
      initial={{ x: 120 + n * 28, y: 140 + n * 28 }}
      onClose={() => closeFloat(fkey)}
    >
      <FramesBody ch={ch} id={id} ext={ext} />
    </FloatingWindow>,
  );
}
