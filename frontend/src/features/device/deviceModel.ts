/** Модель диалогов устройства: выбор скорости канала (стандартная, своя из списка или
 * своя «осиротевшая»), адрес моста и текст «Информации об устройстве». */
import type { ChannelConfig, ChannelState, CustomBitrate, DeviceInfo, Timing } from "../../core/types";
import { t } from "../../i18n/ru";
import { PRESET_BITRATES } from "../../lib/timing";

/** "p:<бит/с>" — стандартная, "c:<индекс>" — своя из списка, "cur" — своя, которой нет в списке. */
export type BitrateChoice = string;

export function kbpsLabel(bitrate: number): string {
  const k = Math.round(bitrate) / 1000;
  return `${String(k).replace(".", ",")} ${t.bitrate.kbps}`;
}

const sameTiming = (a: Timing, b: Timing) =>
  a.prescaler === b.prescaler && a.seg1 === b.seg1 && a.seg2 === b.seg2 && a.sjw === b.sjw;

export function choiceOf(ch: Pick<ChannelConfig, "bitrate" | "timing">, customs: CustomBitrate[]): BitrateChoice {
  if (!ch.timing) return `p:${ch.bitrate ?? 500_000}`;
  const i = customs.findIndex((c) => sameTiming(c.timing, ch.timing!));
  return i >= 0 ? `c:${i}` : "cur";
}

export function customLabel(c: CustomBitrate): string {
  return c.caption ? `${c.caption} — ${kbpsLabel(c.bitrate)}` : kbpsLabel(c.bitrate);
}

export function bitrateOptions(
  customs: CustomBitrate[],
  ch: Pick<ChannelConfig, "bitrate" | "timing">,
): { value: BitrateChoice; label: string }[] {
  const opts = PRESET_BITRATES.map((b) => ({ value: `p:${b}`, label: kbpsLabel(b) }));
  customs.forEach((c, i) => opts.push({ value: `c:${i}`, label: customLabel(c) }));
  if (choiceOf(ch, customs) === "cur") opts.push({ value: "cur", label: `${t.device.own} — ${kbpsLabel(ch.bitrate ?? 0)}` });
  return opts;
}

export function applyChoice(
  choice: BitrateChoice,
  ch: Pick<ChannelConfig, "bitrate" | "timing">,
  customs: CustomBitrate[],
): Pick<ChannelConfig, "bitrate" | "timing"> {
  if (choice.startsWith("p:")) return { bitrate: Number(choice.slice(2)), timing: null };
  if (choice.startsWith("c:")) {
    const c = customs[Number(choice.slice(2))];
    if (c) return { bitrate: c.bitrate, timing: { ...c.timing } };
  }
  return { bitrate: ch.bitrate, timing: ch.timing };
}

export function parseBridge(host: string, port: string): { bridge_host: string; bridge_port: number } {
  const h = host.trim();
  if (!h) throw new Error(t.device.errBridgeHost);
  const p = Number(port.trim());
  if (!/^\d+$/.test(port.trim()) || p < 1 || p > 65535) throw new Error(t.device.errBridgePort);
  return { bridge_host: h, bridge_port: p };
}

/** Порядок особенностей канала — как в ресурсах десктопа (rsCIFeature*). */
const CH_FEATURES = ["csd", "alc", "terminator", "pullup", "idle", "dsd", "noniso"];

/** Строки окна «Информация об устройстве» (в десктопе — моноширинный memo). */
export function deviceInfoLines(info: DeviceInfo, channels?: Record<string, ChannelState>): string[] {
  const d = t.device;
  const out: string[] = [];
  if (info.hardware_name) out.push(`${d.device}: ${info.hardware_name}`);
  if (info.serial_int != null) out.push(`${d.serial}: ${info.serial_int}`);
  if (info.firmware_version) out.push(`${d.firmware}: ${info.firmware_version}`);
  out.push("", `${d.features}:`);
  const feats = [
    info.feature_gateway && d.featureGateway,
    info.feature_isotp && d.featureIsotp,
    info.feature_tx_buffer && d.featureTxBuffer,
    info.feature_tx_task && d.featureTxTask,
  ].filter((x): x is string => Boolean(x));
  out.push(...(feats.length ? feats : [d.featuresNo]).map((f) => `  ${f}`));
  const types = Object.entries(info.channel_types ?? {}).filter(([, type]) => type && type !== "NONE");
  if (types.length) {
    out.push("", `${d.channels}:`);
    for (const [n, type] of types) {
      const parts = [d.channelType(n, type)];
      const hz = info.channel_frequencies?.[n];
      if (hz) parts.push(d.mhz(hz));
      const flt = info.filters_info?.find((f) => String(f.channel) === n);
      if (flt) parts.push(d.filtersCount(flt.size));
      out.push(`  ${parts.join(", ")}`);
      const st = channels?.[n];
      if (st) out.push(`    ${channelStateText(st)}`);
      const cf = info.channel_features?.[n];
      if (cf) {
        const names = CH_FEATURES.filter((k) => cf[k]).map((k) => d.chFeatures[k]);
        out.push(`    ${d.features}:`, ...(names.length ? names : [d.featuresNo]).map((f) => `      ${f}`));
      }
    }
  }
  return out;
}

function channelStateText(st: ChannelState): string {
  const d = t.device;
  const low = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
  let parts: string[];
  if (st.error) parts = [`${low(d.chFail)}: ${st.error}`];
  else if (!st.open) parts = [low(d.chClosed)];
  else {
    parts = [low(d.chOpen), st.bitrate ? kbpsLabel(st.bitrate) : low(d.own)];
    if (st.listen_only) parts.push(low(d.modeSilent));
    if (st.terminator) parts.push(d.terminatorOn);
  }
  return `${d.state}: ${parts.join(", ")}`;
}
