/** Вопрос «Да / Нет» в виде модального диалога (замена window.confirm). */
import { closeDialog, openDialog } from "../app/ui";
import { t } from "../i18n/ru";
import { Dialog } from "./Dialog";

export function confirmDialog(title: string, text: string, yes = t.common.yes, no = t.common.no): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      closeDialog();
      resolve(v);
    };
    openDialog(
      <Dialog title={title} onClose={() => done(false)} onOk={() => done(true)} okLabel={yes} cancelLabel={no} width={440}>
        <p style={{ margin: 0 }}>{text}</p>
      </Dialog>,
    );
  });
}
