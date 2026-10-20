/** «Информация об устройстве»: прибор, прошивка, возможности и каналы — как
 * моноширинный memo десктопа; текст можно выделить или скопировать целиком. */
import { closeDialog } from "../../app/ui";
import { pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { Dialog } from "../../ui/Dialog";
import { deviceInfoLines } from "./deviceModel";

export function DeviceInfoDialog({ onClose = closeDialog }: { onClose?: () => void }) {
  const st = store.status.value;
  const text = st.device_info
    ? deviceInfoLines(st.device_info, st.state === "opened" ? st.channels : undefined).join("\n")
    : t.device.notConnected;
  const copy = () =>
    navigator.clipboard
      .writeText(text)
      .then(() => pushToast("info", t.device.copied))
      .catch((e: Error) => pushToast("error", e.message));
  return (
    <Dialog
      title={t.device.infoDialog}
      onClose={onClose}
      width={560}
      footerLeft={
        <button type="button" class="btn" onClick={copy}>
          {t.device.copy}
        </button>
      }
    >
      <pre class="devinfo" tabIndex={0} aria-label={t.device.infoText}>
        {text}
      </pre>
    </Dialog>
  );
}
