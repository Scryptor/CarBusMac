/** Часовой пояс пользователя для бэкенда: в Docker у контейнера своё время (UTC), а имя
 * файла фоновой записи и `# $LocalTime` трейса должны быть по местному времени. */
import { cmd } from "./client";

export function reportTimeZone(): void {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) void cmd("client_tz", { tz }).catch(() => {});
}
