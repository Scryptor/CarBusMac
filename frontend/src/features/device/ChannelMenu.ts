/** Меню кнопки «Изменение опций каналов» на тулбаре: информация об устройстве, по
 * подменю на канал (терминатор — если прибор его умеет) и настройки устройства. */
import { runAction } from "../../core/actions";
import { cmd } from "../../core/client";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import type { MenuItem } from "../../ui/Menu";

export function channelMenu(): MenuItem[] {
  const st = store.status.value;
  const items: MenuItem[] = [{ action: "deviceInfo" }, { separator: true }];
  for (const [n, ch] of Object.entries(st.channels)) {
    const hasTerminator = Boolean(st.device_info?.channel_features?.[n]?.terminator);
    items.push({
      label: t.receive.channelCaption(Number(n), ch.alias),
      disabled: !ch.open,
      items: [
        {
          label: t.device.terminator,
          checked: ch.terminator,
          disabled: !hasTerminator,
          run: () =>
            void cmd("channel_terminator", { channel: Number(n), enabled: !ch.terminator }).catch((e: Error) =>
              pushToast("error", e.message),
            ),
        },
      ],
    });
  }
  items.push({ separator: true }, { label: `${t.device.dialog}…`, run: () => runAction("deviceSettings") });
  return items;
}
