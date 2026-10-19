/** Форматирование CAN-идентификаторов и данных для таблиц. */

export function formatId(id: number, extended: boolean): string {
  const width = extended ? 8 : 3;
  return "0x" + id.toString(16).toUpperCase().padStart(width, "0");
}

export function formatData(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
