/** Панель фильтров (справа, Ctrl+F): вкладка «Фильтр ID/Маска» — слоты прибора по
 * каналам с флажками; вкладка «Фильтр Диапазон» — диапазоны по каналам с исключениями.
 * Флажок включает/выключает сразу, двойной щелчок открывает настройку. */
import { signal } from "@preact/signals";
import { FilePlus2, FolderOpen, Pencil, Save, Trash2 } from "lucide-preact";
import { useMemo, useState } from "preact/hooks";
import { closeDialog, openDialog } from "../../app/ui";
import { slots as workspaceSlots } from "../../app/Workspace";
import { cmd } from "../../core/client";
import { fmtHex } from "../../core/format";
import { pushToast, store } from "../../core/store";
import type { HwSlotJson, RangeFilterJson } from "../../core/types";
import { t } from "../../i18n/ru";
import { Selection } from "../../ui/grid/selection";
import { VirtualGrid, type Column } from "../../ui/grid/VirtualGrid";
import { Tabs } from "../../ui/Tabs";
import { FileDialog } from "../files/FileDialog";
import { ExclusionDialog, HwFilterDialog, RangeFilterDialog } from "./dialogs";
import { describeExclusion, describeRange } from "./filtersModel";

const toastErr = (e: Error) => pushToast("error", e.message);
const tab = signal<"hw" | "range">("hw");
/** Выделение в дереве диапазонов: диапазон и (необязательно) исключение. */
const rangeSel = signal<{ id: string; ex: number | null } | null>(null);

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: preact.ComponentChildren }) {
  return (
    <button type="button" class="toolbtn" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function HwTab() {
  const f = store.filters.value;
  const simple = store.settings.value.filter_simple_mode;
  const sel = useMemo(() => new Selection(), []);
  const [focus, setFocus] = useState<number | null>(null); // карандаш доступен, когда выбран слот
  const slots = f.hw;
  const edit = (s: HwSlotJson | undefined) => s && openDialog(<HwFilterDialog slot={s} />);
  const columns: Column<HwSlotJson>[] = [
    {
      key: "on",
      title: "",
      width: 34,
      align: "center",
      render: (s) => (
        <input
          type="checkbox"
          class="row-check"
          aria-label={`${t.filters.enable} ${s.channel}/${s.index}`}
          checked={s.enabled}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={() => cmd("hw_set", { slot: { ...s, enabled: !s.enabled } }).catch(toastErr)}
        />
      ),
    },
    { key: "ch", title: t.col.ch, width: 40, align: "center", render: (s) => <span class={`ch-tag${s.channel === 2 ? " ch2" : ""}`}>{s.channel}</span> },
    { key: "num", title: t.col.num, width: 50, align: "right", render: (s) => s.index },
    { key: "id", title: t.col.id, width: 96, align: "right", render: (s) => fmtHex(s.can_id, 8) },
  ];
  if (!simple) columns.push({ key: "mask", title: t.col.mask, width: 96, align: "right", render: (s) => fmtHex(s.mask, 8) });

  const saveAs = () =>
    openDialog(
      <FileDialog mode="save" kind="lists" title={t.filters.saveDialog} defaultName="filters" extensions={[".json"]} onClose={closeDialog}
        onPick={(name) => {
          closeDialog();
          cmd<{ name?: string }>("hw_save", { name })
            .then((d) => pushToast("info", t.filters.saved(d?.name ?? name)))
            .catch(toastErr);
        }} />,
    );
  const load = () =>
    openDialog(
      <FileDialog mode="open" kind="lists" title={t.filters.openDialog} extensions={[".json"]} onClose={closeDialog}
        onPick={(name) => {
          closeDialog();
          cmd("hw_load", { name })
            .then(() => pushToast("info", t.filters.loaded(name)))
            .catch(toastErr);
        }} />,
    );

  return (
    <div class="flt-tab">
      <div class="flt-tools">
        <IconBtn label={t.filters.open} onClick={load}><FolderOpen size={17} /></IconBtn>
        <IconBtn label={t.filters.save} onClick={saveAs}><Save size={17} /></IconBtn>
        <IconBtn label={t.common.edit} disabled={focus == null || !slots[focus]} onClick={() => edit(focus != null ? slots[focus] : undefined)}>
          <Pencil size={17} />
        </IconBtn>
        <span class="tool-spacer" />
        <span class="muted">{t.filters.countOf(slots.filter((s) => s.enabled).length, slots.length)}</span>
      </div>
      <div class="flt-body">
        <VirtualGrid<HwSlotJson>
          gridId={simple ? "hw-simple" : "hw"}
          ariaLabel={simple ? t.filters.hwTabSimple : t.filters.hwTab}
          columns={columns}
          rowCount={slots.length}
          getRow={(i) => slots[i]}
          version={JSON.stringify(slots).length}
          rowClass={(s) => (s.enabled ? "active" : undefined)}
          selection={sel}
          onSelectionChange={() => setFocus(sel.focus)}
          onActivate={(i) => edit(slots[i])}
          emptyText={t.filters.hwEmpty}
        />
      </div>
      <div class="flt-hint muted">{t.filters.hwHint}</div>
    </div>
  );
}

function RangeTab() {
  const ranges = store.filters.value.ranges;
  const simple = store.settings.value.filter_simple_mode;
  const s = rangeSel.value;
  const current = s ? ranges.find((r) => r.id === s.id) ?? null : null;
  const upsert = (r: RangeFilterJson) => cmd("range_upsert", { filter: r }).catch(toastErr);
  const del = () => {
    if (!current || !s) return;
    if (s.ex != null) {
      upsert({ ...current, exclusions: current.exclusions.filter((_, i) => i !== s.ex) });
      rangeSel.value = { id: current.id, ex: null };
    } else {
      cmd("range_delete", { id: current.id }).catch(toastErr);
      rangeSel.value = null;
    }
  };
  const byChannel = [1, 2].map((ch) => ({ ch, items: ranges.filter((r) => r.channel === ch) }));
  return (
    <div class="flt-tab">
      <div class="flt-tools">
        <IconBtn label={t.filters.addRange} onClick={() => openDialog(<RangeFilterDialog range={null} />)}><FilePlus2 size={17} /></IconBtn>
        <IconBtn label={t.filters.addExclusion} disabled={!current} onClick={() => current && openDialog(<ExclusionDialog range={current} index={null} />)}>
          <span class="txt-icon">−ID</span>
        </IconBtn>
        <IconBtn
          label={t.common.edit}
          disabled={!current}
          onClick={() =>
            current && openDialog(s?.ex != null ? <ExclusionDialog range={current} index={s.ex} /> : <RangeFilterDialog range={current} />)
          }
        >
          <Pencil size={17} />
        </IconBtn>
        <IconBtn label={t.common.remove} disabled={!current} onClick={del}><Trash2 size={17} /></IconBtn>
      </div>
      <div class="flt-body tree" role="tree" aria-label={t.filters.rangeTab}>
        {byChannel.map(({ ch, items }) => (
          <div role="group" aria-label={t.receive.channelCaption(ch, "")}>
            <div class="tree-ch">
              <span class={`ch-tag${ch === 2 ? " ch2" : ""}`}>{ch}</span> {t.receive.channelCaption(ch, "")}
              <span class="muted">{items.some((r) => r.enabled) ? "" : t.filters.acceptAll}</span>
            </div>
            {items.map((r) => (
              <>
                <div
                  role="treeitem"
                  class={"tree-item" + (s?.id === r.id && s.ex == null ? " sel" : "")}
                  onClick={() => (rangeSel.value = { id: r.id, ex: null })}
                  onDblClick={() => openDialog(<RangeFilterDialog range={r} />)}
                >
                  <input type="checkbox" class="row-check" aria-label={t.filters.enableItem(describeRange(r))} checked={r.enabled}
                    onClick={(e) => e.stopPropagation()} onChange={() => upsert({ ...r, enabled: !r.enabled })} />
                  <span class="tree-text" title={describeRange(r)}>{describeRange(r)}</span>
                </div>
                {r.exclusions.map((ex, i) => (
                  <div
                    role="treeitem"
                    class={"tree-item sub" + (s?.id === r.id && s.ex === i ? " sel" : "")}
                    onClick={() => (rangeSel.value = { id: r.id, ex: i })}
                    onDblClick={() => openDialog(<ExclusionDialog range={r} index={i} />)}
                  >
                    <input type="checkbox" class="row-check" aria-label={t.filters.enableItem(describeExclusion(ex, simple))} checked={ex.enabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => upsert({ ...r, exclusions: r.exclusions.map((x, k) => (k === i ? { ...x, enabled: !x.enabled } : x)) })} />
                    <span class="tree-text" title={describeExclusion(ex, simple)}>{describeExclusion(ex, simple)}</span>
                  </div>
                ))}
              </>
            ))}
          </div>
        ))}
      </div>
      <div class="flt-hint muted">{t.filters.softHint}</div>
    </div>
  );
}

export function FiltersPanel() {
  const simple = store.settings.value.filter_simple_mode;
  return (
    <div class="panel filters-panel">
      <Tabs
        tabs={[
          { id: "hw", label: simple ? t.filters.hwTabSimple : t.filters.hwTab },
          { id: "range", label: t.filters.rangeTab },
        ]}
        active={tab.value}
        onChange={(id) => (tab.value = id as "hw" | "range")}
      />
      {tab.value === "hw" ? <HwTab /> : <RangeTab />}
    </div>
  );
}

export function registerFilters(): void {
  workspaceSlots.filters = () => <FiltersPanel />;
}
