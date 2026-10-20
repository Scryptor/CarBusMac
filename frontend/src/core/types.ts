/** JSON-формы протокола WS v2 (зеркало backend/app/hub.py и schemas.py). */

export interface MonitorRowJson {
  ch: number;
  id: number;
  ext: boolean;
  rtr: boolean;
  fd: boolean;
  brs: boolean;
  dlc: number;
  data: string; // hex
  count: number;
  period_ms: number | null;
  changed: number; // маска изменившихся байт с прошлого тика
  stable_ms: (number | null)[];
  fc: number;
  ts: number;
}

export interface FrameRowJson {
  i: number;
  t: number; // секунды от первого кадра
  ch: number;
  dir: "rx" | "tx";
  id: number;
  ext: boolean;
  rtr: boolean;
  dlc: number;
  data: string;
  marker: { label: string; comment: string } | null;
}

export interface TracerRowJson extends FrameRowJson {
  enabled: boolean;
  bp: boolean;
  before_ms: number;
  after_ms: number;
  comment: string;
}

export interface Marker {
  index: number;
  label: string;
  comment: string;
  auto: boolean;
}

export interface Timing {
  prescaler: number;
  seg1: number;
  seg2: number;
  sjw: number;
}

export interface ChannelState {
  open: boolean;
  alias: string;
  bitrate: number | null;
  timing: Timing | null;
  listen_only: boolean;
  terminator: boolean;
  error: string | null;
}

export interface DeviceInfo {
  hardware_name?: string;
  firmware_version?: string;
  serial_int?: number;
  feature_gateway?: boolean;
  feature_isotp?: boolean;
  feature_tx_buffer?: boolean;
  feature_tx_task?: boolean;
  channel_types?: Record<string, string>;
  channel_features?: Record<string, Record<string, boolean>>;
  channel_frequencies?: Record<string, number>;
  filters_info?: { channel: number; size: number }[];
  [k: string]: unknown;
}

export interface StatusState {
  state: "closed" | "opening" | "opened" | "error";
  message: string;
  device_info: DeviceInfo | null;
  channels: Record<string, ChannelState>;
}

export interface ChannelConfig {
  channel: number;
  alias: string;
  bitrate: number | null;
  timing: Timing | null;
  listen_only: boolean;
  terminator: boolean;
  auto_open: boolean;
}

export interface ConnectionConfig {
  bridge_host: string;
  bridge_port: number;
  channels: ChannelConfig[];
}

export interface CustomBitrate {
  caption: string;
  bitrate: number;
  sample_pct: number;
  /** тактовая частота, для которой рассчитан тайминг */
  clock_hz: number;
  timing: Timing;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  grid_font: string;
  grid_font_size: number;
  mark_changed: boolean;
  mark_color: string;
  mark_hold_ms: number;
  aggregator: boolean;
  rare_mode: boolean;
  rare_period_ms: number;
  monitor_hex_ids: boolean;
  monitor_sort: boolean;
  monitor_group_by_channel: boolean;
  restore_tx_on_start: boolean;
  tracer_max_1s: boolean;
  copy_header: boolean;
  copy_id_hex: boolean;
  copy_data_hex: boolean;
  filter_new_active: boolean;
  filter_restore_on_start: boolean;
  filter_simple_mode: boolean;
  log_autostart: boolean;
  log_record_tx: boolean;
  log_name_mask: string;
  log_meta: { transport: string; brand: string; model: string; body: string; year: string };
}

export interface CaptureState {
  recording: boolean;
  count: number;
  duration_s: number;
  full: boolean;
  rev: number;
  markers: Marker[];
}

export interface TriggerJson {
  action: "none" | "single" | "start" | "stop";
  delay_ms: number;
  channel: number;
  can_id: number | null;
  ext: boolean;
  dlc: number | null;
  data: (number | null)[];
}

export interface TxTaskJson {
  id: string;
  channel: number;
  can_id: number;
  ext: boolean;
  rtr: boolean;
  data: string;
  period_ms: number;
  comment: string;
  running: boolean;
  count: number;
  trigger: TriggerJson;
}

export interface HwSlotJson {
  channel: number;
  index: number;
  enabled: boolean;
  can_id: number;
  mask: number;
  ext: boolean;
}

export interface RangeExclusionJson {
  enabled: boolean;
  can_id: number;
  mask: number;
}

export interface RangeFilterJson {
  id: string;
  channel: number;
  enabled: boolean;
  start: number;
  end: number;
  exclusions: RangeExclusionJson[];
}

export interface FiltersState {
  hw: HwSlotJson[];
  hw_layout: Record<string, number>;
  ranges: RangeFilterJson[];
}

export interface PlayerConfig {
  delay_mode: "timestamp" | "fixed";
  fixed_ms: number;
  max_1s: boolean;
  loop: boolean;
  dest: "ch1" | "ch2" | "monitor";
  only_channel: number | null;
  stop_on_bp: boolean;
  stop_on_rx: boolean;
}

export interface TracerState {
  name: string | null;
  modified: boolean;
  count: number;
  channels: number[];
  rev: number;
  state: "stopped" | "playing" | "paused";
  current: number | null;
  config: PlayerConfig;
  breakpoints: number[];
}

export interface FileInfo {
  name: string;
  size: number;
  mtime: number;
}
