/** Подписи и разбор ввода для панели фильтров — формулировки русского десктопа. */
import { fmtHex, parseHexId } from "../../core/format";
import type { RangeExclusionJson, RangeFilterJson } from "../../core/types";
import { t } from "../../i18n/ru";

const idText = (v: number) => fmtHex(v, v > 0x7ff ? 8 : 3);

export function describeRange(r: RangeFilterJson): string {
  return t.filters.rangeCaption(r.channel, idText(r.start), idText(r.end));
}

export function describeExclusion(ex: RangeExclusionJson, simple: boolean): string {
  return t.filters.exclusionCaption(idText(ex.can_id), simple ? null : idText(ex.mask));
}

export function parseExcludeList(s: string): number[] {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    try {
      return parseHexId(p, true);
    } catch {
      throw new Error(`Неверный идентификатор в списке исключений: ${p}`);
    }
  });
}

/** Новый список исключений из строки ID: у оставшихся сохраняем маску и флажок. */
export function rangeWithExcludeList(r: RangeFilterJson, ids: number[]): RangeFilterJson {
  const old = new Map(r.exclusions.map((e) => [e.can_id, e]));
  return {
    ...r,
    exclusions: ids.map((id) => old.get(id) ?? { enabled: true, can_id: id, mask: id > 0x7ff ? 0x1fffffff : 0x7ff }),
  };
}
