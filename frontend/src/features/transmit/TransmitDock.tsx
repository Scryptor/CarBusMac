/** Док «CAN Передача» (frameCANTasks десктопа): таблица задач с флажком цикла,
 * редактор выделенной задачи (правка сразу уходит на сервер), строка триггера,
 * кнопки Послать/Добавить/Старт-Пауза/Копировать/Удалить и контекстное меню. */
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { cmd } from "../../core/client";
import { fmtData, fmtFlags, fmtId } from "../../core/format";
import { pushToast, store } from "../../core/store";
import type { TxTaskJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { openContextMenu } from "../../ui/ContextMenu";
import { ByteCells, Check, Select, TextInput } from "../../ui/Fields";
import type { MenuItem } from "../../ui/Menu";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { EMPTY8, FieldError, fillData, newTask, nextTaskId, parseTaskForm, taskToForm, type TaskForm } from "./txModel";

/** id выделенной задачи — общий для дока, контекстного меню и действий. */
export const txSelected = signal<string | null>(null);

/** Операции редактора (досохраняют правку перед командой) — для меню, хоткеев и таблицы. */
export const txApi: {
  send?: () => void;
  runPause?: () => void;
  add?: () => void;
  copy?: () => void;
  del?: () => void;
  /** отправить отложенную правку сейчас */
  flush?: () => Promise<void>;
} = {};

const toastErr = (e: Error) => pushToast("error", e.message);

export function selectedTask(): TxTaskJson | null {
  const id = txSelected.value;
  return store.tasks.value.find((x) => x.id === id) ?? null;
}

export function txMenu(): MenuItem[] {
  return [
    { action: "txAdd" },
    { action: "txCopy" },
    { action: "txDelete" },
    { action: "txClear" },
    { separator: true },
    { action: "txSingle" },
    { action: "txRunPause" },
    { separator: true },
    { action: "txRunAll" },
    { action: "txStopAll" },
    { separator: true },
    { action: "txReset" },
    { action: "txResetAll" },
    { separator: true },
    { action: "txLoad" },
    { action: "txSave" },
  ];
}

function sameContent(a: TxTaskJson, b: TxTaskJson): boolean {
  const strip = (x: TxTaskJson) => JSON.stringify({ ...x, running: false, count: 0 });
  return strip(a) === strip(b);
}

function TaskGrid({ tasks }: { tasks: TxTaskJson[] }) {
  const sel = useMemo(() => new Selection(), []);
  const idx = tasks.findIndex((x) => x.id === txSelected.value);
  if (idx < 0) sel.clear();
  else if (sel.focus !== idx) sel.click(idx);

  const columns: Column<TxTaskJson>[] = [
    {
      key: "run",
      title: "",
      width: 34,
      align: "center",
      render: (r) => (
        <input
          type="checkbox"
          class="row-check"
          aria-label={`${t.tx.startPause} ${fmtId(r.can_id, r.ext, true)}`}
          checked={r.running}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const box = e.currentTarget as HTMLInputElement;
            void (txApi.flush?.() ?? Promise.resolve())
              .then(() => cmd(r.running ? "tx_pause" : "tx_start", { id: r.id }))
              .catch((err: Error) => {
                // не запустилась (нет подключения) — флажок показывает то, что на самом деле
                box.checked = store.tasks.value.find((x) => x.id === r.id)?.running ?? false;
                toastErr(err);
              });
          }}
        />
      ),
    },
    { key: "ch", title: t.col.ch, width: 40, align: "center", render: (r) => <span class={`ch-tag${r.channel === 2 ? " ch2" : ""}`}>{r.channel}</span> },
    {
      key: "flags",
      title: t.col.flags,
      width: 92,
      render: (r) => (
        <span title={r.trigger.action !== "none" ? `${t.tx.trigger}: ${t.tx.actions[r.trigger.action]}` : undefined}>
          {fmtFlags({ rtr: r.rtr, fd: false, brs: false })}
          {r.trigger.action !== "none" ? <span class="trig-badge">⚡</span> : null}
        </span>
      ),
    },
    // ID — всегда HEX, как в редакторе (и в десктопе): с выключенным в мониторе «ID сообщения
    // в HEX» одно и то же число стояло бы в таблице в DEC, а в редакторе в HEX
    { key: "id", title: t.col.id, width: 96, align: "right", render: (r) => fmtId(r.can_id, r.ext, true) },
    { key: "dlc", title: t.col.dlc, width: 48, align: "center", render: (r) => r.data.length / 2 },
    {
      key: "data",
      title: t.col.data,
      width: 222,
      render: (r) => (r.rtr ? null : fmtData(r.data).map((b) => <span class="byte">{b}</span>)), // у RTR данных нет
    },
    { key: "period", title: t.col.period, width: 84, align: "right", render: (r) => r.period_ms },
    { key: "count", title: t.col.count, width: 84, align: "right", render: (r) => r.count },
    { key: "comment", title: t.col.comment, width: 200, fill: true, render: (r) => r.comment },
  ];

  return (
    <VirtualGrid<TxTaskJson>
      gridId="tx"
      ariaLabel={t.tx.tab}
      columns={columns}
      rowCount={tasks.length}
      getRow={(i) => tasks[i]}
      version={tasks.reduce((s, x) => s + x.count, tasks.length)}
      rowClass={(r) => (r.running ? "running" : undefined)}
      selection={sel}
      onSelectionChange={() => {
        txSelected.value = sel.focus != null ? tasks[sel.focus]?.id ?? null : null;
      }}
      onContextMenu={(e, i) => {
        if (i != null && tasks[i]) txSelected.value = tasks[i].id;
        openContextMenu(e.clientX, e.clientY, txMenu());
      }}
      onActivate={() => (txApi.send ? txApi.send() : void cmd("tx_send", { id: txSelected.value }).catch(toastErr))}
      onKey={(e) => {
        if (e.key !== "Escape" || txSelected.value == null) return false;
        txSelected.value = null;            // Esc снимает выделение — редактор становится черновиком
        e.preventDefault();
        return true;
      }}
      emptyText={t.tx.empty}
    />
  );
}

const CHANNELS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
];
const TRIG_CH = [
  { value: "0", label: t.common.all },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
];
const ACTIONS = (["none", "single", "start", "stop"] as const).map((a) => ({ value: a, label: t.tx.actions[a] }));
/** Поле ID — под 8 цифр 29-битного ID и при 11-битном: «29 bit» не сдвигает строку. */
const ID_WIDTH = 96;
/** Ячейки данных RTR: данных нет — пустые и заблокированы (DLC при этом есть). */
const NO_DATA = EMPTY8();

function Editor({ tasks }: { tasks: TxTaskJson[] }) {
  const current = tasks.find((x) => x.id === txSelected.value) ?? null;
  const curId = current?.id ?? null;
  const draftRef = useRef<TxTaskJson>(newTask(nextTaskId(tasks)));
  const base = current ?? draftRef.current;
  /** Поля формы вместе с id задачи, которой они принадлежат (null — черновик). Пока форма не
   * перезагружена после смены выделения, показываются и правятся поля выделенной задачи, а не
   * прежней: change() не смешает форму одной задачи с id другой. */
  const [edit, setEdit] = useState(() => ({ id: curId, form: taskToForm(base) }));
  const form = edit.id === curId ? edit.form : taskToForm(base);
  const setForm = (f: TaskForm) => setEdit({ id: curId, form: f });
  const [bad, setBad] = useState<{ field: string; msg: string } | null>(null);
  const [fillValue, setFillValue] = useState("00");
  const dirty = useRef(false);
  /** Отложенная правка: какая задача и с каким содержимым уйдёт на сервер через 300 мс после
   * последнего ввода. Хранится вместе с id — правка не теряется при смене выделения и не
   * достаётся другой задаче. */
  const pending = useRef<{ task: TxTaskJson; timer: ReturnType<typeof setTimeout> } | null>(null);
  const loadedFor = useRef<string | null>(curId);

  /** Отправить отложенную правку сейчас. */
  const flush = async () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    await cmd("tx_upsert", { task: p.task });
    if (loadedFor.current === p.task.id && !pending.current) dirty.current = false;
  };

  /** Перед действием над задачей формы: отложенную правку другой задачи — отправить, своей —
   * снять (форма уйдёт целиком). */
  const settle = async () => {
    const p = pending.current;
    if (!p) return;
    if (p.task.id !== current?.id) return flush();
    clearTimeout(p.timer);
    pending.current = null;
  };

  // Смена выделения или изменение задачи с сервера (загрузка списка) — перезагрузить форму.
  // Layout-эффект — сразу после отрисовки, до следующего ввода: обычный эффект выполнялся
  // после кадра, и правка в эти 20–50 мс уходила выделенной задаче с полями прежней.
  useLayoutEffect(() => {
    if (curId !== loadedFor.current) {
      void flush().catch(toastErr); // правка прежней задачи уходит, а не теряется
      loadedFor.current = curId;
      dirty.current = false;
      setBad(null);
      setForm(taskToForm(base));
      return;
    }
    if (current && !dirty.current) {
      try {
        if (!sameContent(parseTaskForm(form, current), current)) setForm(taskToForm(current));
      } catch {
        setForm(taskToForm(current));
      }
    }
  }, [current]);

  const submit = (f: TaskForm): TxTaskJson | null => {
    try {
      const task = parseTaskForm(f, current ?? { ...draftRef.current, id: nextTaskId(tasks) });
      setBad(null);
      return task;
    } catch (e) {
      if (e instanceof FieldError) setBad({ field: e.field, msg: e.message });
      return null;
    }
  };

  const upsert = async (task: TxTaskJson) => {
    await cmd("tx_upsert", { task });
    // пока ждали ответ, могли напечатать ещё — тогда форма остаётся «изменённой»,
    // иначе эхо сервера со старым содержимым откатило бы поля
    if (!pending.current) dirty.current = false;
    if (!current) {
      loadedFor.current = task.id;
      txSelected.value = task.id;
      draftRef.current = newTask(nextTaskId([...tasks, task]));
    }
  };

  const change = (patch: Partial<TaskForm>) => {
    const f = { ...form, ...patch };
    setForm(f);
    dirty.current = true;
    void settle().catch(toastErr);          // новая правка этой задачи заменяет отложенную
    const task = submit(f);
    if (!task || !current) return;          // черновик сохраняется по «Послать»/«Добавить»
    pending.current = { task, timer: setTimeout(() => void flush().catch(toastErr), 300) };
  };

  /** Сначала досохранить правку, потом выполнить команду над задачей формы. */
  const withTask = async (fn: (task: TxTaskJson) => Promise<unknown>) => {
    await settle();
    const task = submit(form);
    if (!task) return;
    if (dirty.current || !current) await upsert(task);
    await fn(task);
  };

  const send = () => void withTask((x) => cmd("tx_send", { id: x.id })).catch(toastErr);
  const runPause = () => {
    if (!current) return;                   // цикл — только у выделенной задачи; черновик не запускаем
    void withTask((x) => cmd(current.running ? "tx_pause" : "tx_start", { id: x.id })).catch(toastErr);
  };
  /** «Добавить» — новая пустая задача, как в десктопе (копия выделенной — «Копировать»);
   * без выделения — задача из черновика. */
  const add = () => {
    let task = newTask(nextTaskId(tasks));
    if (!current) {
      const parsed = submit(form);
      if (!parsed) return;                  // ошибка в черновике показана — нулевую задачу не добавляем
      task = { ...parsed, id: task.id, running: false, count: 0 };
    }
    void flush()                            // правка выделенной задачи уходит, как ушла бы через 300 мс
      .then(() => cmd("tx_upsert", { task }))
      .then(() => {
        txSelected.value = task.id;
      })
      .catch(toastErr);
  };
  const copy = () => {
    if (!current) return;
    // копия — того, что в редакторе (с несохранённой правкой), а не последнего сохранённого
    void withTask(async (x) => {
      const task = { ...x, id: nextTaskId(tasks), running: false, count: 0 };
      await cmd("tx_upsert", { task });
      txSelected.value = task.id;
    }).catch(toastErr);
  };
  const del = () => {
    if (!current) return;
    const p = pending.current;
    if (p?.task.id === current.id) {        // отложенная правка не должна воскресить удалённую задачу
      clearTimeout(p.timer);
      pending.current = null;
    }
    const i = tasks.findIndex((x) => x.id === current.id);
    const next = tasks[i + 1] ?? tasks[i - 1] ?? null;
    void cmd("tx_delete", { id: current.id }).then(() => (txSelected.value = next?.id ?? null)).catch(toastErr);
  };

  Object.assign(txApi, { send, runPause, add, copy, del, flush });
  useEffect(
    () => () => {
      for (const k of Object.keys(txApi)) delete txApi[k as keyof typeof txApi];
    },
    [],
  );

  /** «Значение» + «Заполнить»: ошибку показывает само поле «Значение». */
  const fill = () => {
    try {
      change({ data: fillData(fillValue, 8) });
    } catch (e) {
      setBad({ field: "value", msg: `${t.tx.value}: ${(e as Error).message}` });
    }
  };

  const err = (field: string) => bad?.field === field;
  const dlc = Number(form.dlc) || 0;
  const trigDlc = form.trigDlc.trim() === "" ? 8 : Number(form.trigDlc) || 0; // пустой DLC триггера — любой
  const keyEnter = (e: KeyboardEvent) => {
    // Enter — «Послать»; поле со своим Enter («Значение» — «Заполнить») уже обработало его
    if (e.key === "Enter" && !e.defaultPrevented && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div class="tx-editor" onKeyDown={keyEnter}>
      <div class="tx-lines">
        <div class="tx-line">
          <label class="field">
            <span>{t.tx.channel}</span>
            <Select value={form.channel} options={CHANNELS} onChange={(v) => change({ channel: v })} label={t.tx.channel} />
          </label>
          <label class="field">
            <span>{t.tx.id}</span>
            <TextInput value={form.id} onChange={(v) => change({ id: v.toUpperCase() })} width={ID_WIDTH} mono invalid={err("id")} label={t.tx.id} maxLength={8} />
          </label>
          <label class="field">
            <span>{t.tx.dlc}</span>
            <TextInput value={form.dlc} onChange={(v) => change({ dlc: v })} width={34} mono invalid={err("dlc")} label={t.tx.dlc} maxLength={1} />
          </label>
          <span class="field">
            <span>{t.tx.data}</span>
            <ByteCells
              count={8}
              active={form.rtr ? 0 : dlc}
              value={form.rtr ? NO_DATA : form.data}
              onChange={(v) => change({ data: v })}
              label={t.tx.data}
            />
          </span>
          <label class="field grow">
            <span>{t.tx.comment}</span>
            <input class="inp grow" aria-label={t.tx.comment} value={form.comment} maxLength={200} onInput={(e) => change({ comment: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
        <div class="tx-line">
          <Check checked={form.ext} onChange={(v) => change({ ext: v })} label={t.tx.bit29} />
          <Check checked={form.rtr} onChange={(v) => change({ rtr: v })} label={t.tx.rtr} />
          <label class="field">
            <span>{t.tx.period}</span>
            <TextInput value={form.period} onChange={(v) => change({ period: v })} width={64} mono invalid={err("period")} label={t.tx.period} maxLength={5} />
          </label>
          <label class="field">
            <span>{t.tx.value}</span>
            <TextInput
              value={fillValue}
              onChange={(v) => {
                setFillValue(v);
                if (bad?.field === "value") setBad(null);
              }}
              onEnter={fill}
              width={40}
              mono
              invalid={err("value")}
              label={t.tx.value}
              maxLength={2}
              disabled={form.rtr}
            />
          </label>
          <button type="button" class="btn small" onClick={fill} disabled={form.rtr}>
            {t.tx.fill}
          </button>
          <span class="err-text tx-err" role="alert">
            {bad?.msg ?? ""}
          </span>
        </div>
        <div class="tx-line trigger">
          <label class="field">
            <span>{t.tx.trigger}</span>
            <Select value={form.trigAction} options={ACTIONS} onChange={(v) => change({ trigAction: v })} label={t.tx.trigger} />
          </label>
          <fieldset class="tx-trig" disabled={form.trigAction === "none"}>
            <span class="field">
              <span>{t.tx.delay}</span>
              <TextInput value={form.trigDelay} onChange={(v) => change({ trigDelay: v })} width={56} mono invalid={err("trigDelay")} label={t.tx.delay} maxLength={5} />
            </span>
            <span class="field">
              <span>{t.tx.triggerCh}</span>
              <Select value={form.trigCh} options={TRIG_CH} onChange={(v) => change({ trigCh: v })} label={t.tx.triggerCh} />
            </span>
            <span class="field">
              <span>{t.tx.id}</span>
              <TextInput value={form.trigId} onChange={(v) => change({ trigId: v.toUpperCase() })} width={84} mono invalid={err("trigId")} label={t.tx.trig(t.tx.id)} maxLength={8} />
            </span>
            <span class="field">
              <span>{t.tx.dlc}</span>
              <TextInput value={form.trigDlc} onChange={(v) => change({ trigDlc: v })} width={34} mono invalid={err("trigDlc")} label={t.tx.trig(t.tx.dlc)} maxLength={1} />
            </span>
            <span class="field">
              <span>{t.tx.data}</span>
              <ByteCells
                count={8}
                allowEmpty
                active={trigDlc}
                value={form.trigData}
                onChange={(v) => change({ trigData: v })}
                label={t.tx.trig(t.tx.data)}
              />
            </span>
          </fieldset>
        </div>
      </div>
      <div class="tx-buttons">
        <button type="button" class="btn primary" onClick={send} title="Enter">
          {t.tx.send}
        </button>
        <button type="button" class="btn" onClick={add}>
          {t.tx.add}
        </button>
        <button type="button" class="btn" onClick={runPause} disabled={!current}>
          {current?.running ? t.tx.pause : t.tx.start}
        </button>
        <button type="button" class="btn" onClick={copy} disabled={!current}>
          {t.tx.copy}
        </button>
        <span />
        <button type="button" class="btn" onClick={del} disabled={!current}>
          {t.tx.del}
        </button>
      </div>
    </div>
  );
}

/** Щелчок по пустому месту таблицы (ниже строк) снимает выделение — редактор становится
 * черновиком. Строки, шапка и полоса прокрутки выделение не трогают. */
function deselectOnBlank(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (e.button !== 0 || !el.matches(".grid, .grid-body")) return;
  const grid = el.closest<HTMLElement>(".grid")!;
  const box = grid.getBoundingClientRect();
  if (e.clientX - box.left >= grid.clientWidth || e.clientY - box.top >= grid.clientHeight) return; // полоса прокрутки
  txSelected.value = null;
}

export function TransmitDock() {
  const tasks = store.tasks.value;
  const running = tasks.filter((x) => x.running).length;
  return (
    <div class="tx-dock">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" aria-selected="true">
          {t.tx.tab}
        </button>
        <span class="tool-spacer" />
        <span class="tabs-info muted">
          {t.tx.tasksCount(tasks.length)}
          {running ? t.tx.running(running) : ""}
        </span>
      </div>
      <div class="tx-grid" onMouseDown={deselectOnBlank}>
        <TaskGrid tasks={tasks} />
      </div>
      <Editor tasks={tasks} />
    </div>
  );
}
