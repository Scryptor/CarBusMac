// Аудит раскладки для проверки юзабилити (вставляется в Playwright browser_evaluate).
// Возвращает: переполнение страницы, элементы, обрезанные или вылезшие за вьюпорт,
// и видимый текст мельче 12px. Пустые списки + нули = раскладка в порядке.
() => {
  const vw = innerWidth;
  const vh = innerHeight;
  const doc = document.documentElement;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${id}${cls} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}] ${text}`;
  };
  const clipped = [];
  const controls = document.querySelectorAll("button, input, select, label, [role=tab], [role=menuitem], .toolbtn, th, .cell-clip");
  for (const el of controls) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const out = r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1;
    const overflow = el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible"
      && !(el.tagName === "INPUT" || el.tagName === "SELECT");
    // внутри прокручиваемых контейнеров (грид, списки) выход за вьюпорт — норма
    let scrollParent = el.parentElement;
    let inScroller = false;
    while (scrollParent && scrollParent !== document.body) {
      const ov = getComputedStyle(scrollParent).overflowY;
      if ((ov === "auto" || ov === "scroll") && scrollParent.scrollHeight > scrollParent.clientHeight) { inScroller = true; break; }
      scrollParent = scrollParent.parentElement;
    }
    if ((out && !inScroller) || overflow) clipped.push(describe(el));
  }
  const smallText = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) smallText.push(`${fs}px ${describe(el)}`);
  }
  return {
    viewport: `${vw}x${vh}`,
    pageOverflowX: Math.max(0, doc.scrollWidth - vw),
    pageOverflowY: Math.max(0, doc.scrollHeight - vh),
    clipped: clipped.slice(0, 40),
    smallText: smallText.slice(0, 40),
  };
}
