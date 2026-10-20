/** Раздельный приём (вкладка «Раздельный приём» десктопа): по таблице на канал рядом,
 * с заголовком «Канал N: название». Каналы — открытые на приборе плюс встреченные в данных. */
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { MonitorPanel, monitorStore } from "./MonitorGrid";

export function splitChannels(): number[] {
  monitorStore.version.value;
  const set = new Set<number>();
  for (const [n, ch] of Object.entries(store.status.value.channels)) if (ch.open) set.add(Number(n));
  for (const r of monitorStore.all()) set.add(r.ch);
  if (set.size === 0) set.add(1);
  return [...set].sort((a, b) => a - b);
}

export function SplitMonitor() {
  const chans = splitChannels();
  return (
    <div class="split-receive">
      {chans.map((n) => {
        const alias = store.status.value.channels[String(n)]?.alias ?? "";
        return (
          <section class="split-col" aria-label={t.receive.channelCaption(n, alias)}>
            <div class="split-head">
              <span class={`ch-tag${n === 2 ? " ch2" : ""}`}>{n}</span>
              <span>{t.receive.channelCaption(n, alias)}</span>
            </div>
            <div class="split-body">
              <MonitorPanel channel={n} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
