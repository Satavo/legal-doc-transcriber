import { loadEngine, loadWords, loadContext, recognize } from "./ocr.js";
import { makeDocx } from "./docx.js";

// Служебные символы разметки из ocr.js
const M_OPEN = "", M_SEP = "", M_CLOSE = "", BOX = "";
const MARK_RE = new RegExp(`${M_OPEN}([^${M_SEP}]*)${M_SEP}(\\w+)${M_SEP}([^${M_CLOSE}]*)${M_CLOSE}`, "g");
const BOX_RE = new RegExp(`^${BOX}([\\d,]+)${BOX}`);
const UNK_OPEN = "", UNK_CLOSE = "";   // для .docx: сомнительные слова подсвечиваются

const $ = (id) => document.getElementById(id);
const drop = $("drop"), picker = $("picker"), list = $("files"), output = $("output");
const startBtn = $("start"), clearBtn = $("clear"), msg = $("msg");
let items = [];   // { file, url, status }
let busy = false;
let pages = [];   // фото страниц результата: { url, name }

// Модели скачиваются заранее, пока пользователь выбирает фото
loadEngine().catch(() => {});
loadWords().catch(() => {});
loadContext().catch(() => {});

// Волна от точки нажатия на цветных кнопках
document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest?.(".act");
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2;
  const wave = Object.assign(document.createElement("span"), { className: "ripple" });
  Object.assign(wave.style, { width: size + "px", height: size + "px", left: e.clientX - r.left - size / 2 + "px", top: e.clientY - r.top - size / 2 + "px" });
  b.append(wave);
  wave.addEventListener("animationend", () => wave.remove());
});

// Телефон: камера и галерея. После снимка кнопка предлагает снять следующую страницу
// Телефонный режим — как в CSS: сенсорный экран или узкое окно
const isTouch = matchMedia("(hover: none) and (pointer: coarse), (max-width: 700px)").matches;
$("cameraBtn").addEventListener("click", () => $("camera").click());
$("galleryBtn").addEventListener("click", () => picker.click());
$("camera").addEventListener("change", () => { addFiles($("camera").files); $("camera").value = ""; });

drop.addEventListener("click", () => picker.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") picker.click(); });
picker.addEventListener("change", () => { addFiles(picker.files); picker.value = ""; });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
document.addEventListener("paste", (e) => { if (e.clipboardData?.files.length) addFiles(e.clipboardData.files); });

function addFiles(fileList) {
  const added = [...fileList].filter((f) => f.type.startsWith("image/"));
  added.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of added) items.push({ file, url: URL.createObjectURL(file), status: "", fresh: true });
  render();
}

const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
let dragFrom = -1;   // какую страницу сейчас перетаскивают мышью
function render() {
  list.innerHTML = "";
  items.forEach((it, i) => {
    const li = document.createElement("li");
    const thumb = Object.assign(document.createElement("img"), { src: it.url, alt: "", title: "Открыть фото" });
    thumb.addEventListener("click", () => openViewer(i));
    // Имя и статус друг под другом — на узком экране строка не «расползается»
    const info = Object.assign(document.createElement("div"), { className: "info" });
    info.append(
      Object.assign(document.createElement("div"), { className: "name", textContent: `${i + 1}. ${it.file.name}`, title: it.file.name }),
      Object.assign(document.createElement("div"), { className: "status " + (it.cls || ""), textContent: it.status }),
    );
    const btns = Object.assign(document.createElement("div"), { className: "btns" });
    // Стрелки порядка нужны, только когда страниц больше одной
    if (items.length > 1) btns.append(btn("↑", i === 0, () => move(i, -1), "Выше"), btn("↓", i === items.length - 1, () => move(i, 1), "Ниже"));
    const del = btn("", false, () => remove(i), "Убрать фото");
    del.classList.add("del");
    del.innerHTML = TRASH_ICON;
    btns.append(del);
    li.append(thumb, info, btns);
    if (it.working) { li.classList.add("busy"); info.lastChild.classList.add("working"); }
    if (it.fresh) { li.classList.add("new"); it.fresh = false; }
    // На компьютере порядок страниц можно менять перетаскиванием
    if (!isTouch && items.length > 1 && !busy) {
      li.draggable = true;
      li.title = "Перетащите, чтобы поменять порядок";
      thumb.draggable = false;
      li.addEventListener("dragstart", (e) => {
        dragFrom = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        requestAnimationFrame(() => li.classList.add("dragging"));
      });
      li.addEventListener("dragend", () => { dragFrom = -1; render(); });
      li.addEventListener("dragover", (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        li.classList.toggle("drop-before", !after);
        li.classList.toggle("drop-after", after);
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
      li.addEventListener("drop", (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const after = li.classList.contains("drop-after");
        let to = i + (after ? 1 : 0);
        const [moved] = items.splice(dragFrom, 1);
        if (dragFrom < to) to--;
        items.splice(to, 0, moved);
        dragFrom = -1;
        render();
      });
    }
    list.append(li);
  });
  startBtn.disabled = busy || items.length === 0;
  clearBtn.disabled = busy || items.length === 0;
  $("cameraBtn").querySelector(".lbl").textContent = items.length ? "Сфотографировать ещё страницу" : "Сфотографировать страницу";
}

function btn(label, disabled, onClick, title = "") {
  const b = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: label, disabled: disabled || busy, title });
  if (title) b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

// Просмотр загруженного фото во весь экран
const viewer = $("viewer"), viewerImg = $("viewerImg"), stage = $("viewerStage");
let viewIndex = 0;
function openViewer(i) {
  viewIndex = i;
  viewerImg.src = items[i].url;
  $("viewerTitle").textContent = `${i + 1} из ${items.length} · ${items[i].file.name}`;
  $("viewerPrev").disabled = i === 0;
  $("viewerNext").disabled = i === items.length - 1;
  stage.classList.remove("zoomed");
  viewer.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeViewer() { viewer.hidden = true; document.body.style.overflow = ""; }
const toggleZoom = () => stage.classList.toggle("zoomed");
$("viewerClose").addEventListener("click", closeViewer);
$("viewerPrev").addEventListener("click", () => openViewer(viewIndex - 1));
$("viewerNext").addEventListener("click", () => openViewer(viewIndex + 1));
$("viewerZoom").addEventListener("click", toggleZoom);
viewerImg.addEventListener("click", toggleZoom);
stage.addEventListener("click", (e) => { if (e.target === stage) closeViewer(); });
document.addEventListener("keydown", (e) => {
  if (viewer.hidden) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft" && viewIndex > 0) openViewer(viewIndex - 1);
  else if (e.key === "ArrowRight" && viewIndex < items.length - 1) openViewer(viewIndex + 1);
});

function move(i, d) { [items[i], items[i + d]] = [items[i + d], items[i]]; render(); }
// Фото, по которым уже есть расшифровка, не освобождаем — они нужны для сверки
const inUse = (url) => pages.some((p) => p.url === url);
function remove(i) { if (!inUse(items[i].url)) URL.revokeObjectURL(items[i].url); items.splice(i, 1); render(); }
// «Очистить» убирает и фото, и расшифровку в окне редактирования
clearBtn.addEventListener("click", () => {
  items.forEach((it) => URL.revokeObjectURL(it.url));
  pages.forEach((p) => URL.revokeObjectURL(p.url));
  items = []; pages = [];
  hideSuggest(); clearHighlight(); toggleDocxMenu(false);
  if (isTouch) setEditing(false);
  output.textContent = "";
  issueSpan = null; issueIndex = -1;
  shownPage = -1; renderPageTabs();
  $("photoWrap").hidden = true; $("photoEmpty").hidden = false; $("photoImg").removeAttribute("src"); delete $("photoImg").dataset.url;
  $("resultCard").hidden = true; $("mbar").hidden = true;
  updateIssues(); setMsg("");
  render();
});

startBtn.addEventListener("click", async () => {
  busy = true; output.textContent = ""; setMsg(""); hideSuggest(); clearHighlight();
  $("resultCard").hidden = false;
  $("mbar").hidden = false;
  pages.forEach((p) => items.some((it) => it.url === p.url) || URL.revokeObjectURL(p.url));
  pages = items.map((it) => ({ url: it.url, name: it.file.name }));
  shownPage = -1;
  renderPageTabs();
  items.forEach((it) => { it.status = "в очереди"; it.cls = ""; });
  setLoading(true);
  render();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.status = "обработка…"; it.working = true; render();
    if (items.length > 1) appendResult(`===== Страница ${i + 1} =====`, i, true);
    try {
      appendResult(await recognize(it.file, (s) => { it.status = s; render(); }), i);
      it.status = "готово"; it.cls = "done";
    } catch (e) {
      it.status = "ошибка"; it.cls = "err";
      appendResult(`[Ошибка: ${e.message}]`, i);
      setMsg(e.message, true);
    }
    it.working = false;
    render();
  }
  busy = false;
  setLoading(false);
  render();
  issueIndex = -1;
  updateIssues();   // сколько слов на проверку — видно над текстом и в нижней панели, под кнопками только ошибки
  // Готовый текст — с начала, фото первой страницы
  syncPaused = Date.now() + 1200;
  output.scrollTop = 0;
  showPage(0);
  $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
});

// Во время работы кнопка показывает «Распознаю…», а кружок загрузки — у фото, которое обрабатывается
function setLoading(on) {
  startBtn.classList.toggle("loading", on);
  startBtn.querySelector(".lbl").textContent = on ? "Распознаю…" : "Расшифровать";
}

// Текст сначала только для чтения: нажатие на слово открывает варианты, а не клавиатуру.
// На телефоне править вручную — карандашом в нижней панели и в «⋯»
function setEditing(on) {
  output.contentEditable = on ? "true" : "false";
  output.classList.toggle("editing", on);
  $("mEdit").setAttribute("aria-pressed", String(on)); $("mEdit").classList.toggle("on", on);
  moreMenu.querySelector('[data-act="edit"] .lbl').textContent = on ? "Закончить правку" : "Править текст";
  setMsg(on ? "Режим правки: меняйте текст прямо в поле" : "");
  if (on) { hideSuggest(); output.focus(); }
}
const toggleEditing = () => setEditing(output.contentEditable !== "true");
// На компьютере кнопки нет: текст правится сразу, щелчком в нужное место (варианты слова по щелчку тоже открываются)
if (!isTouch) { output.contentEditable = "true"; output.classList.add("pc-edit"); }
$("mEdit").addEventListener("click", toggleEditing);

// Нижняя панель на телефоне: лупа просто переводит к следующему слову на проверку, варианты — по нажатию на слово
$("mNext").addEventListener("click", () => goIssue(1, false));
$("mSend").addEventListener("click", () => $("emailBtn").click());

// Меню «⋯»: копировать и скачать, не листая до конца текста
const moreMenu = $("moreMenu");
function toggleMore(open = moreMenu.hidden) {
  moreMenu.hidden = !open;
  $("mMore").setAttribute("aria-expanded", String(open));
  if (open) hideSuggest();
}
$("mMore").addEventListener("click", (e) => { e.stopPropagation(); toggleMore(); });
moreMenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  toggleMore(false);
  if (b.dataset.act === "edit") toggleEditing();
  else if (b.dataset.act === "downloadDocx") { e.stopPropagation(); if (serialize().trim()) toggleDocxMenu(true); else setMsg("Сначала расшифруйте документ", true); }
  else $(b.dataset.act).click();
});
document.addEventListener("click", (e) => { if (!moreMenu.hidden && !moreMenu.contains(e.target)) toggleMore(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !moreMenu.hidden) toggleMore(false); });

function setMsg(text, isErr) { msg.textContent = text; msg.className = isErr ? "err" : ""; }

// ——— Результат: каждая строка — блок со ссылкой на своё место на фото ———

function appendResult(str, page, isHead = false) {
  const frag = document.createDocumentFragment();
  for (let line of str.split("\n")) {
    const div = document.createElement("div");
    div.className = "ln" + (isHead ? " page-head" : "");
    if (isHead) div.dataset.label = line.replace(/=+/g, "").trim();
    div.dataset.page = page;
    const box = line.match(BOX_RE);
    if (box) { div.dataset.box = box[1]; line = line.slice(box[0].length); }
    if (!line) { div.append(document.createElement("br")); frag.append(div); continue; }
    let last = 0;
    for (const m of line.matchAll(MARK_RE)) {
      if (m.index > last) div.append(line.slice(last, m.index));
      const cls = { fix: "w-fix", guess: "w-guess", name: "w-name" }[m[2]] || "w-unk";
      const span = Object.assign(document.createElement("span"), { className: cls, textContent: m[1] });
      span.dataset.alts = m[3];
      if (m[2] === "fix") span.dataset.orig = m[3].split("|")[0];
      if (m[2] === "guess") span.dataset.visible = m[1].replace(/\[[^\]]*\]/g, "");
      div.append(span);
      last = m.index + m[0].length;
    }
    div.append(line.slice(last));
    frag.append(div);
  }
  output.append(frag);
}

// Текст поля с учётом правок пользователя; marks — обрамить сомнительные слова для .docx
function serialize(marks = false) {
  let out = "";
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { out += n.data; continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (n.tagName === "BR") { out += "\n"; continue; }
      const block = n.tagName === "DIV" || n.tagName === "P";
      if (block && out && !out.endsWith("\n")) out += "\n";
      const unk = marks && (n.classList.contains("w-unk") || n.classList.contains("w-name"));
      if (unk) out += UNK_OPEN;
      walk(n);
      if (unk) out += UNK_CLOSE;
    }
  };
  walk(output);
  return out.replace(/\n+$/, "");
}

// ——— Сверка с фото ———
const review = $("review"), photoScroll = $("photoScroll"), photoWrap = $("photoWrap"), photoImg = $("photoImg");
const hlLine = $("hlLine"), hlWord = $("hlWord");
let shownPage = -1, zoom = 1, activeLine = null;

$("showPhoto").addEventListener("change", (e) => review.classList.toggle("no-photo", !e.target.checked));

// Вкладки страниц над фото (если страниц больше одной)
function renderPageTabs() {
  const tabs = $("pageTabs");
  tabs.hidden = pages.length < 2;
  tabs.replaceChildren(...pages.map((p, i) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "page-tab", title: p.name });
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", "false");
    b.append(Object.assign(document.createElement("img"), { src: p.url, alt: "" }), `Стр. ${i + 1}`);
    b.addEventListener("click", () => openPage(i));
    return b;
  }));
}

// Выбор страницы вкладкой: фото этой страницы и текст прокручивается к её началу
function openPage(i) {
  clearHighlight();
  showPage(i);
  const head = output.querySelector(`.ln.page-head[data-page="${i}"]`) || output.querySelector(`.ln[data-page="${i}"]`);
  if (!head) return;
  syncPaused = Date.now() + 900;   // пока текст едет к странице, не переключаем фото обратно
  if (output.scrollHeight > output.clientHeight + 2) output.scrollTo({ top: head.offsetTop - output.offsetTop, behavior: "smooth" });
  else window.scrollTo({ top: window.scrollY + head.getBoundingClientRect().top - $("photoPane").getBoundingClientRect().height - 16, behavior: "smooth" });
}

// Листаете текст — фото само переключается на страницу, которую вы читаете
let syncFrame = 0, syncPaused = 0;
function syncPageFromScroll() {
  if (syncFrame || pages.length < 2) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    if (Date.now() < syncPaused || review.classList.contains("no-photo")) return;
    const o = output.getBoundingClientRect(), pane = $("photoPane").getBoundingClientRect();
    // Видимая часть текста. На телефоне фото стоит над текстом и закрывает его верх —
    // тогда считаем от низа фото; на компьютере фото слева и ничего не закрывает
    const stacked = Math.abs(pane.left - o.left) < 2;
    const top = Math.max(o.top, 0, stacked ? pane.bottom : 0), bottom = Math.min(o.bottom, innerHeight);
    if (bottom <= top) return;
    // Фото той страницы, которая занимает большую часть видимого текста: край соседней страницы,
    // выглянувший сверху или снизу, фото не переключает
    const share = new Map();
    for (const l of output.querySelectorAll(".ln")) {
      const r = l.getBoundingClientRect();
      if (r.bottom <= top) continue;
      if (r.top >= bottom) break;
      const p = +l.dataset.page;
      share.set(p, (share.get(p) || 0) + Math.min(r.bottom, bottom) - Math.max(r.top, top));
    }
    let best = shownPage, bestH = share.get(shownPage) || 0;
    for (const [p, h] of share) if (h > bestH + 1) { best = p; bestH = h; }
    if (best >= 0 && best !== shownPage) { clearHighlight(); showPage(best); }
  });
}
output.addEventListener("scroll", syncPageFromScroll, { passive: true });
window.addEventListener("scroll", syncPageFromScroll, { passive: true });

function showPage(i) {
  if (!pages[i]) return Promise.resolve(false);
  $("pageTabs").querySelectorAll(".page-tab").forEach((t, k) => {
    t.setAttribute("aria-selected", String(k === i));
    if (k === i && !$("pageTabs").hidden) t.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // Сравниваем само фото, а не номер страницы: после новой расшифровки «страница 1» — уже другое фото
  if (shownPage === i && photoImg.dataset.url === pages[i].url && photoImg.complete && photoImg.naturalWidth) return Promise.resolve(true);
  shownPage = i;
  photoImg.dataset.url = pages[i].url;
  $("photoEmpty").hidden = true;
  photoWrap.hidden = false;
  $("photoTitle").textContent = pages.length > 1 ? `Страница ${i + 1} · ${pages[i].name}` : pages[i].name;
  return new Promise((res) => {
    photoImg.onload = () => res(true);
    photoImg.onerror = () => res(false);
    photoImg.src = pages[i].url;
  });
}

function setZoom(z) {
  const center = photoScroll.scrollTop / Math.max(1, photoWrap.offsetHeight);
  zoom = Math.min(4, Math.max(1, z));
  photoWrap.style.width = zoom * 100 + "%";
  photoScroll.scrollTop = center * photoWrap.offsetHeight;
}
$("zoomIn").addEventListener("click", () => setZoom(zoom * 1.5));
$("zoomOut").addEventListener("click", () => setZoom(zoom / 1.5));
$("zoomFit").addEventListener("click", () => setZoom(1));

function place(el, box) {
  const w = photoImg.naturalWidth, h = photoImg.naturalHeight;
  Object.assign(el.style, {
    left: (box[0] / w) * 100 + "%", top: (box[1] / h) * 100 + "%",
    width: ((box[2] - box[0]) / w) * 100 + "%", height: ((box[3] - box[1]) / h) * 100 + "%",
  });
  el.hidden = false;
}

function clearHighlight() {
  hlLine.hidden = hlWord.hidden = true;
  activeLine?.classList.remove("active");
  activeLine = null;
}

// Подсвечивает на фото строку и (если известно) слово: span — размеченное слово, range — [начало, конец] в тексте строки
async function highlight(lineDiv, range = null, scroll = true) {
  if (!lineDiv?.dataset.box || review.classList.contains("no-photo")) return;
  if (activeLine !== lineDiv) { activeLine?.classList.remove("active"); activeLine = lineDiv; lineDiv.classList.add("active"); }
  if (!(await showPage(+lineDiv.dataset.page))) return;
  const box = lineDiv.dataset.box.split(",").map(Number);
  place(hlLine, box);
  let target = box;
  if (range) {
    // Положение слова на фото — пропорционально его месту в строке
    const len = Math.max(1, lineDiv.textContent.length), wd = box[2] - box[0];
    const pad = wd * 0.01;
    target = [box[0] + (wd * range[0]) / len - pad, box[1], box[0] + (wd * range[1]) / len + pad, box[3]];
    place(hlWord, target);
  } else hlWord.hidden = true;
  if (scroll) scrollPhotoTo(target);
}

function scrollPhotoTo(box) {
  const scale = photoWrap.offsetWidth / photoImg.naturalWidth;
  const y0 = box[1] * scale, y1 = box[3] * scale, x0 = box[0] * scale, x1 = box[2] * scale;
  const v = photoScroll;
  const visible = y0 >= v.scrollTop + 10 && y1 <= v.scrollTop + v.clientHeight - 10 && x0 >= v.scrollLeft && x1 <= v.scrollLeft + v.clientWidth;
  // На телефоне без «проезда»: фото сразу встаёт на нужную строку, чтобы ничего не дёргалось при тапе
  if (!visible) v.scrollTo({ top: (y0 + y1) / 2 - v.clientHeight / 2, left: Math.max(0, (x0 + x1) / 2 - v.clientWidth / 2), behavior: isTouch ? "auto" : "smooth" });
}

// Смещение точки (узел, смещение) от начала текста строки
function offsetInLine(lineDiv, node, offset) {
  let pos = 0;
  const walker = document.createTreeWalker(lineDiv, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return pos + offset;
    pos += n.data.length;
  }
  return pos;
}

function wordRangeAt(lineDiv, pos) {
  const text = lineDiv.textContent;
  let a = pos, b = pos;
  while (a > 0 && /[\p{L}\d\[\]?…-]/u.test(text[a - 1])) a--;
  while (b < text.length && /[\p{L}\d\[\]?…-]/u.test(text[b])) b++;
  return a < b ? [a, b] : null;
}

function spanRange(span) {
  const lineDiv = span.closest(".ln");
  const start = offsetInLine(lineDiv, span.firstChild, 0);
  return [start, start + span.textContent.length];
}

// Строка и слово в точке экрана (под мышью или под пальцем) — подсветить на фото
function highlightAt(e) {
  const lineDiv = e.target.closest?.(".ln");
  if (!lineDiv || !output.contains(lineDiv)) return;
  const span = e.target.closest(".w-unk, .w-fix, .w-guess, .w-name");
  if (span) return highlight(lineDiv, spanRange(span));
  const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const range = caret ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = caret ? caret.offsetNode : range?.startContainer, off = caret ? caret.offset : range?.startOffset;
  highlight(lineDiv, node && lineDiv.contains(node) ? wordRangeAt(lineDiv, offsetInLine(lineDiv, node, off)) : null);
}
let hoverFrame = 0;
output.addEventListener("mousemove", (e) => {
  if (hoverFrame || isTouch) return;
  hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; highlightAt(e); });
});

// Курсор в тексте (клавиатура, клик) — тоже показываем место на фото
document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  if (!sel.rangeCount || !output.contains(sel.anchorNode)) return;
  const lineDiv = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest(".ln");
  if (lineDiv) highlight(lineDiv, wordRangeAt(lineDiv, offsetInLine(lineDiv, sel.anchorNode, sel.anchorOffset)));
});

// ——— Переход по словам на проверку ———
const issues = () => [...output.querySelectorAll(".w-unk, .w-guess, .w-name")];
let issueIndex = -1, issueSpan = null;

function updateIssues() {
  const all = issues();
  $("prevIssue").disabled = $("nextIssue").disabled = !all.length;
  const pos = issueSpan && all.includes(issueSpan) ? all.indexOf(issueSpan) + 1 : 0;
  $("issueInfo").textContent = all.length ? (pos ? `${pos} из ${all.length}` : `на проверку: ${all.length}`) : output.textContent.trim() ? "Все слова проверены" : "";
  $("mNext").disabled = !all.length;
  const label = all.length ? (pos ? `${pos} из ${all.length}` : `Слова: ${all.length}`) : "Готово ✓";
  const lbl = $("mNext").querySelector(".lbl");
  if (lbl.textContent !== label) {
    lbl.textContent = label;
    // Счётчик «подпрыгивает» при каждом изменении; пока проверка не начата — кнопка мягко пульсирует
    $("mNext").classList.remove("bump"); void $("mNext").offsetWidth; $("mNext").classList.add("bump");
  }
  $("mNext").classList.toggle("pulse", all.length > 0 && !pos);
  $("mNext").classList.toggle("done", !all.length);
}

// open — сразу показать варианты (кнопка на компьютере); лупа на телефоне только переводит к слову
function goIssue(dir, open = true) {
  const all = issues();
  if (!all.length) return updateIssues();
  let i = issueSpan && all.includes(issueSpan) ? all.indexOf(issueSpan) + dir : dir > 0 ? Math.max(0, issueIndex) : all.length - 1;
  if (issueSpan && !all.includes(issueSpan)) i = Math.min(issueIndex, all.length - 1);   // текущее слово только что проверено
  i = (i + all.length) % all.length;
  issueSpan?.classList.remove("w-current");
  issueIndex = i;
  issueSpan = all[i];
  issueSpan.classList.add("w-current");
  // На компьютере прокручиваем только поле текста; на телефоне поле не прокручивается — двигаем страницу
  // так, чтобы слово оказалось ниже закреплённого фото
  const r = issueSpan.getBoundingClientRect();
  if (output.scrollHeight > output.clientHeight + 2) output.scrollTop += r.top - output.getBoundingClientRect().top - output.clientHeight / 3;
  else window.scrollBy({ top: r.top - window.innerHeight * 0.42 });   // сразу под фото, выше шторки с вариантами
  highlight(issueSpan.closest(".ln"), spanRange(issueSpan));
  if (open) setTimeout(() => showSuggest(issueSpan, true), 60); else hideSuggest();
  updateIssues();
}
$("nextIssue").addEventListener("click", () => goIssue(1));
$("prevIssue").addEventListener("click", () => goIssue(-1));
document.addEventListener("keydown", (e) => {
  if (!e.altKey || !viewer.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); goIssue(1); }
  if (e.key === "ArrowUp") { e.preventDefault(); goIssue(-1); }
});

// ——— Подсказки при наведении на слово ———
const suggest = $("suggest");
let suggestFor = null, hideTimer = null, suggestPinned = false;

// at — точка нажатия: у слова, перенесённого на другую строку, окно открывается у той части, куда нажали
function showSuggest(span, pinned = false, at = null) {
  clearTimeout(hideTimer);
  suggestPinned = pinned;
  if (suggestFor === span && !suggest.hidden) return;
  suggestFor = span;
  suggest.innerHTML = "";
  const isFix = span.classList.contains("w-fix"), isGuess = span.classList.contains("w-guess"), isName = span.classList.contains("w-name");
  const alts = span.dataset.alts ? span.dataset.alts.split("|") : [];
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = isName ? "Фамилия или отчество — сверьте с фото, исправить можно прямо в тексте" : isFix ? `Исправлено по словарю. На фото прочитано: «${span.dataset.orig}»`
    : isGuess ? (alts.length ? "Слово обрезано краем — часть букв угадана. Возможно:" : "Слово обрезано краем, вариантов нет — сверьте с фото")
    : alts.length ? "Не уверен в слове. Возможно:" : "Не уверен в слове, вариантов нет — сверьте с фото";
  suggest.append(title);
  const option = (label, value, cls = "") => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, className: cls });
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => resolveWord(span, value));
    suggest.append(b);
  };
  for (const a of alts) option(isFix && a === span.dataset.orig ? `Вернуть «${a}»` : a, a);
  if (isGuess && span.dataset.visible) option(`Только видимое на фото: «${span.dataset.visible}»`, span.dataset.visible, "keep");
  option(isName ? `Верно: «${span.textContent}»` : `Оставить «${span.textContent}»`, span.textContent, "keep");
  suggest.hidden = false;
  const rects = [...span.getClientRects()];
  const r = (at && rects.find((q) => at.y >= q.top - 2 && at.y <= q.bottom + 2)) || rects[0] || span.getBoundingClientRect();
  const x = at ? Math.max(r.left, Math.min(at.x - 24, r.right)) : r.left;   // у курсора, но не левее начала слова
  const left = Math.min(window.scrollX + x, window.scrollX + document.documentElement.clientWidth - suggest.offsetWidth - 8);
  suggest.style.left = Math.max(8, left) + "px";
  suggest.style.top = window.scrollY + r.bottom + 6 + "px";
}
function hideSuggest() { suggest.hidden = true; suggestFor = null; suggestPinned = false; }

// Выбранное слово заменяет размеченное, пометка снимается; при обходе по списку — сразу к следующему
function resolveWord(span, value) {
  const wasCurrent = span === issueSpan;
  span.replaceWith(document.createTextNode(value));
  output.normalize();
  hideSuggest();
  const n = issues().length;
  updateIssues();
  if (wasCurrent && n) goIssue(1);
}

// Варианты слова открываются только по нажатию (клик или тап), а не при наведении
output.addEventListener("click", (e) => {
  highlightAt(e);
  const span = e.target.closest(".w-unk, .w-fix, .w-guess, .w-name");
  if (span) showSuggest(span, true, { x: e.clientX, y: e.clientY }); else hideSuggest();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !suggest.hidden) hideSuggest(); });
document.addEventListener("click", (e) => {
  if (!suggest.contains(e.target) && !e.target.closest("#output, .review-bar, #mbar")) hideSuggest();
});
output.addEventListener("scroll", () => { if (!suggestPinned) hideSuggest(); });
// Вставка в поле — только обычным текстом, без чужого оформления
output.addEventListener("paste", (e) => {
  if (e.clipboardData?.files.length) return;
  e.preventDefault();
  e.stopPropagation();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});
output.addEventListener("input", updateIssues);

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(serialize());
  setMsg("Скопировано");
});
function saveFile(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("download").addEventListener("click", () => {
  saveFile(new Blob([serialize()], { type: "text/plain;charset=utf-8" }), "rasshifrovka.txt");
});
// .docx: с пометками, чистовик или оба — выбор в маленьком меню у кнопки (на телефоне — над нижней панелью)
// Всплывающее меню у кнопки: под ней, а если снизу мало места — над ней. Кнопка скрыта (телефон) — над нижней панелью
function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  if (r.width) {
    const h = menu.offsetHeight, below = r.bottom + 8 + h < innerHeight;
    Object.assign(menu.style, { left: Math.max(12, Math.min(r.left, innerWidth - menu.offsetWidth - 12)) + "px", right: "auto",
      top: (below ? r.bottom + 8 : r.top - 8 - h) + "px", bottom: "auto" });
  } else {
    Object.assign(menu.style, { left: "auto", right: "12px", top: "auto", bottom: "calc(72px + env(safe-area-inset-bottom))" });
  }
  menu.querySelector("button").focus({ preventScroll: true });
}
const docxMenu = $("docxMenu");
function toggleDocxMenu(open = docxMenu.hidden) {
  docxMenu.hidden = !open;
  if (!open) return;
  hideSuggest(); togglePcMore(false);
  placeMenu(docxMenu, $("downloadDocx"));
}
// «⋯» под текстом на компьютере: копировать и скачать .txt
const pcMoreMenu = $("pcMoreMenu");
function togglePcMore(open = pcMoreMenu.hidden) {
  pcMoreMenu.hidden = !open;
  $("pcMore").setAttribute("aria-expanded", String(open));
  if (!open) return;
  hideSuggest(); toggleDocxMenu(false);
  placeMenu(pcMoreMenu, $("pcMore"));
}
$("pcMore").addEventListener("click", (e) => { e.stopPropagation(); togglePcMore(); });
pcMoreMenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pc]");
  if (!b) return;
  togglePcMore(false);
  $(b.dataset.pc).click();
});
document.addEventListener("click", (e) => { if (!pcMoreMenu.hidden && !pcMoreMenu.contains(e.target)) togglePcMore(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pcMoreMenu.hidden) togglePcMore(false); });
$("downloadDocx").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!serialize().trim()) return setMsg("Сначала расшифруйте документ", true);
  toggleDocxMenu();
});
docxMenu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-docx]");
  if (!b) return;
  toggleDocxMenu(false);
  const base = fileBase(), kind = b.dataset.docx;
  if (kind !== "clean") saveFile(makeDocx(serialize(true)), `${base} (с пометками).docx`);
  // Второй файл — с небольшой паузой, иначе браузер может пропустить одно из скачиваний
  if (kind !== "marked") setTimeout(() => saveFile(makeDocx(cleanCopy(serialize())), `${base} (чистовик).docx`), kind === "both" ? 400 : 0);
});
document.addEventListener("click", (e) => { if (!docxMenu.hidden && !docxMenu.contains(e.target)) toggleDocxMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !docxMenu.hidden) toggleDocxMenu(false); });

// ——— Отправка на email ———
// Адреса и пароль отправки запоминаются в этом браузере (localStorage); если хранилище недоступно — просто не запоминаем
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const EMAILS_KEY = "emails", SEND_PW_KEY = "sendPassword", MAX_SAVED = 12;
const emailDlg = $("emailDlg"), emailTo = $("emailTo"), emailMsg = $("emailMsg");
const savedEmails = () => store.get(EMAILS_KEY, []);
const parseEmails = (s) => s.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
const validEmail = (e) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e);
let sendConfigured = null;

function setEmailMsg(text, kind = "") { emailMsg.textContent = text; emailMsg.className = "dlg-msg " + kind; }

function renderSaved() {
  const list = savedEmails();
  $("emailList").replaceChildren(...list.map((e) => Object.assign(document.createElement("option"), { value: e })));
  const chips = $("emailChips");
  chips.replaceChildren(...list.map((e) => {
    const chip = Object.assign(document.createElement("span"), { className: "chip" });
    const pick = Object.assign(document.createElement("button"), { type: "button", textContent: e, title: "Подставить адрес" });
    pick.addEventListener("click", () => {
      const cur = parseEmails(emailTo.value);
      if (!cur.includes(e)) emailTo.value = [...cur, e].join(", ");
      emailTo.focus();
    });
    const del = Object.assign(document.createElement("button"), { type: "button", className: "del", textContent: "×", title: "Убрать из списка" });
    del.setAttribute("aria-label", `Убрать ${e} из списка`);
    del.addEventListener("click", () => { store.set(EMAILS_KEY, savedEmails().filter((x) => x !== e)); renderSaved(); });
    chip.append(pick, del);
    return chip;
  }));
}

function rememberEmails(list) {
  store.set(EMAILS_KEY, [...new Set([...list, ...savedEmails()])].slice(0, MAX_SAVED));
}

$("emailBtn").addEventListener("click", async () => {
  if (!serialize().trim()) return setMsg("Сначала расшифруйте документ", true);
  const name = pages[0]?.name?.replace(/\.[^.]+$/, "") || "документ";
  $("emailSubject").value = `Расшифровка: ${name}` + (pages.length > 1 ? ` и ещё ${pages.length - 1} стр.` : "");
  emailTo.value = savedEmails()[0] || "";
  $("emailPw").value = "";
  $("emailPwRow").hidden = Boolean(store.get(SEND_PW_KEY, ""));
  renderSaved();
  setEmailMsg("");
  $("emailSend").disabled = false;
  emailDlg.showModal();
  if (!emailTo.value) emailTo.focus();
  // Есть ли сервер с настроенной почтой (на GitHub Pages сервера нет — тогда письмо отправляется с почты пользователя)
  if (sendConfigured === null) {
    sendConfigured = await fetch("api/send").then((r) => r.json()).then((j) => j.configured).catch(() => false);
  }
  $("emailGmail").hidden = sendConfigured || canShareFiles();
  if (!sendConfigured) {
    $("emailPwRow").hidden = true;
    $("emailSend").textContent = canShareFiles() ? "Поделиться" : "Почтовая программа";
    setEmailMsg(canShareFiles()
      ? "Откроется «Поделиться» — выберите Gmail или Почту. Текст и оба файла уже будут в письме, а адрес скопируется: в поле «Кому» нажмите «Вставить»."
      : "Письмо откроется в вашей почте с адресатом, темой и текстом. Файлы .docx скачаются — приложите их к письму.");
  }
});

// Меню «Поделиться» с файлами — на телефонах (на компьютере удобнее почта с готовым адресатом)
const canShareFiles = () => matchMedia("(pointer: coarse)").matches
  && Boolean(navigator.canShare?.({ files: [new File(["x"], "x.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] }));
$("emailCancel").addEventListener("click", () => emailDlg.close());

// Пароль отправки проверяем сразу после ввода; принятый запоминаем и поле больше не показываем
async function checkSendPassword() {
  const password = $("emailPw").value;
  if (!password) return false;
  setEmailMsg("Проверяю пароль…");
  const r = await fetch("api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, check: true }) }).catch(() => null);
  if (r?.ok) {
    store.set(SEND_PW_KEY, password);
    $("emailPwRow").hidden = true;
    setEmailMsg("Пароль принят — на этом устройстве его больше вводить не нужно", "ok");
    return true;
  }
  setEmailMsg(r?.status === 401 ? "Неверный пароль отправки" : "Не удалось проверить пароль", "err");
  return false;
}
$("emailPw").addEventListener("change", checkSendPassword);

// Ссылка с ключом: …/#send=ПАРОЛЬ — пароль запоминается, а из адресной строки убирается
const hashKey = location.hash.match(/^#send=(.+)$/);
if (hashKey) {
  store.set(SEND_PW_KEY, decodeURIComponent(hashKey[1]));
  history.replaceState(null, "", location.pathname + location.search);
}

// Чистовик: без пометок — достроенные слова целиком («[дей?]ствительности» → «действительности»), «[…]» убраны
const cleanCopy = (text) => text
  .replace(/\[([^\]]*)\?\]/g, "$1")
  .replace(/ ?\[…\] ?/g, (m) => (m.startsWith(" ") && m.endsWith(" ") ? " " : ""));

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fileBase = () => ($("emailSubject").value || "Расшифровка").replace(/:\s*/g, " - ").replace(/[\\/*?"<>|]/g, "_").slice(0, 80);

function readRecipients() {
  const to = parseEmails(emailTo.value);
  if (!to.length || !to.every(validEmail)) { setEmailMsg("Проверьте адрес: например, name@example.com", "err"); return null; }
  if (to.length > 5) { setEmailMsg("Не больше 5 адресов за раз", "err"); return null; }
  return to;
}

// Без сервера: письмо уходит с почты пользователя — «Поделиться» на телефоне, Gmail или почтовая программа на компьютере
async function sendFromOwnMail(target) {
  const to = readRecipients();
  if (!to) return;
  const subject = $("emailSubject").value || "Расшифровка документа";
  const base = fileBase();
  const files = $("emailAttach").checked ? [
    new File([makeDocx(serialize(true))], `${base} (с пометками).docx`, { type: DOCX_TYPE }),
    new File([makeDocx(cleanCopy(serialize()))], `${base} (чистовик).docx`, { type: DOCX_TYPE }),
  ] : [];
  rememberEmails(to);
  renderSaved();
  if (target === "share") {
    // Адресата в меню «Поделиться» передать нельзя — копируем его, чтобы вставить в поле «Кому».
    // Без await перед share: иначе телефон может посчитать, что нажатие уже «прошло», и не открыть меню
    navigator.clipboard?.writeText(to.join(", ")).catch(() => {});
    try {
      // Текст письма — чистовик; почтовые приложения кладут его в тело письма, а title — в тему
      await navigator.share({ ...(files.length ? { files } : {}), title: subject, text: cleanCopy(serialize()) });
      setEmailMsg(`Адрес скопирован — в поле «Кому» нажмите «Вставить»: ${to.join(", ")}`, "ok");
    } catch (err) {
      if (err.name !== "AbortError") setEmailMsg("Не удалось открыть меню «Поделиться»: " + err.message, "err");
    }
    return;
  }
  // Ссылки на письмо не вмещают длинный текст — в теле начало, полный текст во вложениях
  const full = cleanCopy(serialize());
  const LIMIT = 1500;
  const body = (full.length > LIMIT ? full.slice(0, LIMIT) + "…\n\n" : full + "\n\n") + (files.length ? "Полный текст — во вложенных файлах .docx." : "");
  files.forEach((f) => saveFile(f, f.name));
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  if (target === "gmail") window.open(`https://mail.google.com/mail/?view=cm&fs=1&${q({ to: to.join(","), su: subject, body })}`, "_blank", "noopener");
  else location.href = `mailto:${to.map(encodeURIComponent).join(",")}?${q({ subject, body })}`;
  setEmailMsg(files.length ? `Письмо открыто. Приложите скачанные файлы: «${files[0].name}» и «${files[1].name}».` : "Письмо открыто в почте.", "ok");
}
$("emailGmail").addEventListener("click", () => sendFromOwnMail("gmail"));

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sendConfigured) return sendFromOwnMail(canShareFiles() ? "share" : "app");
  const to = readRecipients();
  if (!to) return;
  const password = $("emailPw").value || store.get(SEND_PW_KEY, "");
  if (!password) { $("emailPwRow").hidden = false; $("emailPw").focus(); return setEmailMsg("Введите пароль отправки", "err"); }
  $("emailSend").disabled = true;
  setEmailMsg("Отправляю…");
  try {
    const base = fileBase();
    const files = $("emailAttach").checked ? [
      { name: `${base} (с пометками).docx`, data: await blobToBase64(makeDocx(serialize(true))) },
      { name: `${base} (чистовик).docx`, data: await blobToBase64(makeDocx(cleanCopy(serialize()))) },
    ] : [];
    const body = { to: to.join(", "), subject: $("emailSubject").value, password, text: cleanCopy(serialize()), files };
    const r = await fetch("api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `Ошибка ${r.status}` }));
    if (j.needPassword) { store.set(SEND_PW_KEY, ""); $("emailPwRow").hidden = false; $("emailPw").value = ""; $("emailPw").focus(); }
    else { store.set(SEND_PW_KEY, password); $("emailPwRow").hidden = true; }   // пароль подошёл, даже если сама отправка не удалась
    if (!r.ok) throw new Error(j.error || `Ошибка ${r.status}`);
    rememberEmails(to);
    renderSaved();
    setEmailMsg(`Отправлено: ${to.join(", ")}`, "ok");
    setMsg(`Письмо отправлено: ${to.join(", ")}`);
    setTimeout(() => emailDlg.open && emailDlg.close(), 1500);
  } catch (err) {
    setEmailMsg(err.message, "err");
  } finally {
    $("emailSend").disabled = false;
  }
});
