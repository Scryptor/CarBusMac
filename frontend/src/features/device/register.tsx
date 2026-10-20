/** Подключение функций устройства к каркасу: «Подключиться» и «Настройки устройства»
 * открывают диалог подключения, меню кнопки опций каналов строит ChannelMenu. */
import { Cpu, SlidersHorizontal } from "lucide-preact";
import { toolbarHooks } from "../../app/MainToolbar";
import { connectHooks } from "../../app/shellActions";
import { openDialog } from "../../app/ui";
import { registerActions } from "../../core/actions";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import { channelMenu } from "./ChannelMenu";
import { ConnectDialog } from "./ConnectDialog";
import { DeviceInfoDialog } from "./DeviceInfoDialog";

export function registerDevice(): void {
  const openSettings = () => openDialog(<ConnectDialog />);
  connectHooks.openConnectDialog = openSettings;
  toolbarHooks.channelMenu = channelMenu;
  registerActions([
    { id: "deviceSettings", label: t.device.dialog, icon: SlidersHorizontal, scope: "global", run: openSettings },
    {
      id: "deviceInfo",
      label: t.menu.deviceInfo,
      icon: Cpu,
      scope: "global",
      enabled: () => store.status.value.device_info != null,
      run: () => openDialog(<DeviceInfoDialog />),
    },
  ]);
}
