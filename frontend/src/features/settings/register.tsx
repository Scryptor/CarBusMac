/** «Настройки приложения» (меню «Настройки») и «Настройки фонового логирования
 * потока» (кнопка тулбара) — один диалог, открытый на нужном разделе. */
import { ScrollText, Settings } from "lucide-preact";
import { openDialog } from "../../app/ui";
import { registerActions } from "../../core/actions";
import { t } from "../../i18n/ru";
import { SettingsDialog } from "./SettingsDialog";

export function registerSettings(): void {
  registerActions([
    {
      id: "appSettings",
      label: t.menu.appSettings,
      icon: Settings,
      scope: "global",
      run: () => openDialog(<SettingsDialog />),
    },
    {
      id: "logSettings",
      label: t.hint.logs,
      icon: ScrollText,
      scope: "global",
      run: () => openDialog(<SettingsDialog initialTab="log" />),
    },
  ]);
}
