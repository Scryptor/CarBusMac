/** Меню кнопки «Пауза между отправкой сообщений» и «Точка назначения передачи»: как pmDelay
 * и pmTransmit окна отладчика десктопа. */
import { openDialog } from "../../app/ui";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import type { PlayerConfig } from "../../core/types";
import { t } from "../../i18n/ru";
import type { MenuItem } from "../../ui/Menu";
import { CustomDelayDialog } from "./CustomDelayDialog";

const FIXED = [10, 20, 30, 40, 50];

export const setPlayer = (patch: Partial<PlayerConfig>) =>
  void cmd("tracer_config", { patch }).catch((e: Error) => pushToast("error", e.message));

export function delayMenuItems(): MenuItem[] {
  const c = store.tracer.value.config;
  const fixed = c.delay_mode === "fixed";
  const custom = fixed && !FIXED.includes(c.fixed_ms);
  return [
    { label: t.tracer.delayDefault, checked: !fixed, run: () => setPlayer({ delay_mode: "timestamp" }) },
    { label: t.tracer.delayMax1s, checked: c.max_1s, disabled: fixed, run: () => setPlayer({ max_1s: !c.max_1s }) },
    { separator: true },
    ...FIXED.map((ms) => ({
      label: t.tracer.delayFixed(ms),
      checked: fixed && c.fixed_ms === ms,
      run: () => setPlayer({ delay_mode: "fixed", fixed_ms: ms }),
    })),
    { separator: true },
    {
      label: custom ? `${t.tracer.delayCustom} (${t.tracer.ms(c.fixed_ms)})` : t.tracer.delayCustom,
      checked: custom,
      run: () => openDialog(<CustomDelayDialog />),
    },
  ];
}

export function destLabel(c: PlayerConfig): string {
  return c.dest === "monitor" ? t.tracer.destMonitor : t.tracer.destCh(c.dest === "ch2" ? 2 : 1);
}

export function destMenuItems(): MenuItem[] {
  const c = store.tracer.value.config;
  return (["ch1", "ch2", "monitor"] as const).map((dest) => ({
    label: destLabel({ ...c, dest }),
    checked: c.dest === dest,
    run: () => setPlayer({ dest }),
  }));
}
