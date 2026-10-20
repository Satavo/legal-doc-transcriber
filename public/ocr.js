// Распознавание текста в браузере: PaddleOCR (PP-OCRv3 детектор + PP-OCRv5 East Slavic) на onnxruntime-web.
// Требует глобальный `ort` (vendor/ort.wasm.min.js).
//
// Сомнительные слова возвращаются в тексте разметкой: слововидвариант1|вариант2,
// где вид — "unk" (не удалось уверенно прочитать), "fix" (исправлено по словарю, первым вариантом идёт прочитанное)
// "guess" (слово обрезано краем, достроенная часть в квадратных скобках, варианты — полные слова)
// или "name" (фамилия или отчество — прочитано уверенно, но стоит сверить с фото).

const DET_MAX_SIDE = 2240;     // макс. сторона изображения для детектора (кратно 32)
const DET_THRESH = 0.3;        // порог бинаризации карты вероятностей
const BOX_THRESH = 0.5;        // мин. средняя вероятность внутри области
const UNCLIP_RATIO = 1.6;      // насколько расширять найденные области
const REC_HEIGHT = 48;
const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
// Символы, которые бывают в юридических документах; всё прочее (∀, ➀, | …) модели выдавать запрещено
const ALLOWED = /^[А-Яа-яЁёA-Za-z0-9 .,;:!?\-–—()[\]«»"'\/%№§&+°₽$€]$/u;

const M_OPEN = "", M_SEP = "", M_CLOSE = "";
const BOX = "";   // x0,y0,x1,y1 в начале строки — её место на фото

let enginePromise = null;

export function loadEngine(onProgress = () => {}) {
  if (!enginePromise) {
    enginePromise = (async () => {
      ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      onProgress("Загрузка моделей распознавания…", 0.02);
      const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const [det, rec, dict] = await Promise.all([
        ort.InferenceSession.create("models/det.onnx", opts),
        ort.InferenceSession.create("models/rec.onnx", opts),
        fetch("models/dict.txt").then((r) => r.text()),
      ]);
      // Классы модели: 0 — blank (CTC), затем символы словаря, последний — пробел
      const chars = ["", ...dict.split(/\r?\n/).filter((c, i, a) => c !== "" || i < a.length - 1), " "];
      const allowed = chars.map((c, i) => i === 0 || ALLOWED.test(c));
      return { det, rec, chars, allowed };
    })().catch((e) => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

// Главная функция: файл изображения → текст страницы
export async function recognize(file, onProgress = () => {}, debug = null) {
  const engine = await loadEngine(onProgress);
  const wordsPromise = loadWords();
  guessAlts.clear();
  const bitmap = await createImageBitmap(file);
  const src = document.createElement("canvas");
  src.width = bitmap.width; src.height = bitmap.height;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.fillStyle = "#fff"; sctx.fillRect(0, 0, src.width, src.height);
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  onProgress("Поиск строк текста…", 0.05);
  const boxes = await detect(engine.det, src);
  const lines = [];
  const info = new Map();   // слово → { minP, probs, alts } — насколько модель уверена в каждой букве
  for (let i = 0; i < boxes.length; i++) {
    // Вторым аргументом — доля готовности страницы (0…1), чтобы страница могла показать полосу прогресса
    if (i % 3 === 0) onProgress(`Чтение строк: ${i} из ${boxes.length}…`, 0.1 + 0.8 * (i / Math.max(1, boxes.length)));
    const r = await recognizeBox(engine, src, boxes[i]);
    const meanP = r.probs.length ? r.probs.reduce((a, b) => a + b, 0) / r.probs.length : 0;
    const text = cleanFragment(r, info);
    if (text && !isJunk(text, meanP)) lines.push({ ...boxes[i], text, meanP });
  }
  // Мелкий текст (печати, штампы) не смешиваем со строками документа
  const hs = lines.filter((l) => l.L > l.H * 4).map((l) => l.H).sort((a, b) => a - b);
  const typicalH = hs[hs.length >> 1] || 0;
  const isCaps = (t) => { const s = t.replace(/\P{L}/gu, ""); return s.length >= 5 && (s.match(/\p{Lu}/gu) || []).length >= s.length * 0.7; };
  for (const l of lines) {
    // Сравниваем с соседними строками: из-за перспективы низ листа на фото крупнее верха
    const near = lines.filter((o) => o !== l && Math.abs(o.cy - l.cy) < typicalH * 8 && o.L > o.H * 4 && !isCaps(o.text)).map((o) => o.H).sort((a, b) => a - b);
    const localH = near[near.length >> 1] || typicalH;
    // Надпись печати: короткая, заглавными и мельче соседних строк
    l.small = typicalH > 0 && (l.H < localH * 0.65 || (isCaps(l.text) && l.H < localH * 0.9 && l.L < l.H * 14));
  }
  if (debug) Object.assign(debug, { lines, typicalH });

  const words = await wordsPromise.catch(() => null);
  const vocab = docVocabulary(lines);
  if (words) {
    for (const line of lines) {
      if (line.edgeR) line.text = completeEnd(line.text, words, vocab);
      if (line.edgeL) line.text = completeStart(line.text, words, vocab);
    }
  }
  onProgress("Проверка слов по словарю…", 0.92);
  // Слова в начале и конце строки могли уйти в изгиб страницы — достраиваем и там
  const fixRowEdges = (row) => {
    if (!words) return;
    const first = row[0], last = row[row.length - 1];
    if (!first.edgeL && !first.small) first.text = completeStart(first.text, words, vocab, true);
    if (!last.edgeR && !last.small) last.text = completeEnd(last.text, words, vocab, true);
  };
  const out = layout(lines, fixRowEdges);
  const joined = joinHyphens(out, words, vocab);
  let page = joined.map((l) => polishLine(l, words, vocab, info)).join("\n");
  const ctx = words && (await loadContext().catch(() => null));
  if (ctx) page = applyContext(page, words, vocab, ctx);
  // В начало каждой строки — где она на фото: x0,y0,x1,y1 (страница использует это для сверки)
  return page.split("\n").map((l, i) => {
    const b = joined.boxes?.[i];
    return b && l ? `${BOX}${b.map(Math.round).join(",")}${BOX}${l}` : l;
  }).join("\n");
}

// Обрывки подписей и рамок печати: «AHEH», «X», «9 НИ», «*»
function isJunk(text, meanP) {
  const core = text.replace(/[^\p{L}\d]/gu, "");
  if (!core) return !/^[-–—]$/.test(text.trim());   // одинокий дефис переноса — не мусор
  if (meanP < 0.5) return true;
  if (/^[вксоуиая]$/i.test(core) && meanP >= 0.6) return false;   // при широких пробелах «и», «в» — отдельные фрагменты
  if (core.length <= 3 && meanP < 0.9) return true;
  if (/^[A-Za-z]+$/.test(core) && core.length <= 5 && meanP < 0.95) return true;
  return false;
}

// ——— Детектор строк ———

export async function detect(session, src) {
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(src.width, src.height));
  const w = Math.max(32, Math.round((src.width * scale) / 32) * 32);
  const h = Math.max(32, Math.round((src.height * scale) / 32) * 32);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // NCHW, порядок каналов BGR, как в PaddleOCR
  const input = new Float32Array(3 * w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      input[ch * n + i] = (px[i * 4 + (2 - ch)] / 255 - DET_MEAN[ch]) / DET_STD[ch];
    }
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, h, w]) });
  const prob = out[session.outputNames[0]].data;
  const sx = src.width / w, sy = src.height / h;

  // Связные области на бинарной карте → повёрнутые прямоугольники (строки на фото часто с наклоном)
  const comps = findComponents(prob, w, h, DET_THRESH, null).map((pix) => measure(pix, prob, w)).filter(Boolean);
  // Типичная толщина строки на этой странице
  const thicks = comps.filter((c) => c.len > c.thick * 4).map((c) => c.thick).sort((a, b) => a - b);
  const lineThick = thicks.length ? thicks[thicks.length >> 1] : 0;
  const parts = [];
  for (const c of comps) {
    // Изогнутая строка: по столбцам она тонкая, а описанный прямоугольник — толстый
    if (c.thick > c.colH * 1.35 && c.len > c.colH * 6 && isCurved(c)) { c.curved = true; parts.push(c); continue; }
    // Соседние строки слились в одну область: делим её более строгим порогом
    if (lineThick && c.thick > lineThick * 1.7 && c.len > lineThick * 3) {
      const split = splitMerged(c, prob, w, h, lineThick);
      if (split) { parts.push(...split); continue; }
    }
    parts.push(c);
  }
  const boxes = parts.map((c) => toBox(c, w, sx, sy, src, lineThick));
  attachSatellites(boxes);
  return boxes.filter((b) => !b.attached);
}

// Дефис, точка или запятая у конца строки детектор часто находит отдельной крошкой —
// одна она распознаётся как «1» или мусор. Пристёгиваем её к соседней строке.
function attachSatellites(boxes) {
  const long = boxes.filter((b) => b.L > b.H * 4 && !b.curve);
  const hs = long.map((b) => b.H).sort((a, b) => a - b);
  const lineH = hs[hs.length >> 1];
  if (!lineH) return;
  for (const s of boxes) {
    if (s.L > s.H * 2 || s.H > lineH * 0.5) continue;   // только знаки ниже половины строки, не буквы рамки печати
    for (const l of long) {
      if (Math.abs(l.angle) > 0.05 || Math.abs(s.cy - l.cy) > l.H * 0.5) continue;
      const gapR = s.x0 - l.x1, gapL = l.x0 - s.x1;
      // С запасом: знак на самом краю вырезанной строки модель не замечает
      const pad = l.H * 0.4;
      if (gapR > -l.H && gapR < l.H * 1.2 && s.x1 + pad > l.x1) {
        const grow = s.x1 + pad - l.x1;
        l.L += grow; l.cx += grow / 2; l.x1 += grow; l.edgeR ||= s.edgeR;
      } else if (gapL > -l.H && gapL < l.H * 1.2 && s.x0 - pad < l.x0) {
        const grow = l.x0 - (s.x0 - pad);
        l.L += grow; l.cx -= grow / 2; l.x0 -= grow; l.edgeL ||= s.edgeL;
      } else continue;
      s.attached = true;
      break;
    }
  }
}

// Связные области пикселей с вероятностью текста ≥ thresh (в пределах region, если задан)
const scratch = { size: 0 };
function findComponents(prob, w, h, thresh, region) {
  const N = w * h;
  if (scratch.size !== N) Object.assign(scratch, { size: N, seen: new Uint8Array(N), allow: new Uint8Array(N), stack: new Int32Array(N) });
  const { seen, allow, stack } = scratch;
  seen.fill(0);
  if (region) { allow.fill(0); for (const p of region) allow[p] = 1; }
  const ok = (p) => prob[p] >= thresh && (!region || allow[p]);
  const out = [];
  const starts = region || { length: N, [Symbol.iterator]: function* () { for (let i = 0; i < N; i++) yield i; } };
  for (const s of starts) {
    if (seen[s] || !ok(s)) continue;
    const pix = [];
    let sp = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp];
      pix.push(p);
      const x = p % w;
      if (x > 0 && !seen[p - 1] && ok(p - 1)) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && ok(p + 1)) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (p >= w && !seen[p - w] && ok(p - w)) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (p < N - w && !seen[p + w] && ok(p + w)) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (pix.length >= 10) out.push(pix);
  }
  return out;
}

// Положение, наклон и размеры области (в координатах карты детектора)
function measure(pix, prob, w) {
  const n = pix.length;
  let sum = 0, mx = 0, my = 0, x0 = Infinity, x1 = -Infinity;
  for (const p of pix) { const x = p % w; sum += prob[p]; mx += x; my += (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  if (sum / n < BOX_THRESH) return null;
  mx /= n; my /= n;
  // Наклон строки — по главной оси облака точек
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of pix) { const dx = (p % w) - mx, dy = ((p / w) | 0) - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
  let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  if (Math.abs(angle) > 0.26) angle = 0;   // больше ~15° — скорее не строка текста, не поворачиваем
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pix) {
    const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const len = u1 - u0 + 1, thick = v1 - v0 + 1;
  if (thick < 3) return null;
  if (len < thick * 1.5) angle = 0;          // короткие фрагменты (цифры, знаки) не поворачиваем
  // Профиль по столбцам: настоящая высота строки и её средняя линия (на изгибе страницы строка — дуга)
  const cw = x1 - x0 + 1;
  const top = new Float32Array(cw).fill(Infinity), bot = new Float32Array(cw).fill(-Infinity);
  for (const p of pix) {
    const i = (p % w) - x0, y = (p / w) | 0;
    if (y < top[i]) top[i] = y;
    if (y > bot[i]) bot[i] = y;
  }
  const heights = [];
  for (let i = 0; i < cw; i++) if (bot[i] >= top[i]) heights.push(bot[i] - top[i] + 1);
  heights.sort((a, b) => a - b);
  const colH = heights[(heights.length * 0.75) | 0] || thick;
  return { pix, n, mx, my, angle, u0, u1, v0, v1, len, thick, x0, x1, colH, top, bot };
}

// Строка действительно изогнута: средняя линия заметно отходит от прямой (а не просто наклонена)
function isCurved(c) {
  const yc = centerLine(c), n = yc.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += yc[i]; sxx += i * i; sxy += i * yc[i]; }
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), b = (sy - k * sx) / n;
  let dev = 0;
  for (let i = 0; i < n; i++) dev = Math.max(dev, Math.abs(yc[i] - (k * i + b)));
  return dev > c.colH * 0.35;
}

// Средняя линия изогнутой строки: центр каждого столбца, пропуски заполнены, сглажено
function centerLine(c) {
  const cw = c.x1 - c.x0 + 1;
  const yc = new Float32Array(cw);
  let last = -1;
  for (let i = 0; i < cw; i++) {
    if (c.bot[i] < c.top[i]) continue;
    yc[i] = (c.top[i] + c.bot[i]) / 2;
    if (last >= 0 && i - last > 1) for (let k = last + 1; k < i; k++) yc[k] = yc[last] + ((yc[i] - yc[last]) * (k - last)) / (i - last);
    if (last < 0) for (let k = 0; k < i; k++) yc[k] = yc[i];
    last = i;
  }
  for (let k = last + 1; k < cw; k++) yc[k] = yc[last];
  const r = Math.max(2, Math.round(c.colH * 1.5));
  const out = new Float32Array(cw);
  for (let i = 0; i < cw; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(cw - 1, i + r); k++) { s += yc[k]; n++; }
    out[i] = s / n;
  }
  return out;
}

function splitMerged(c, prob, w, h, lineThick) {
  for (const t of [0.45, 0.6, 0.75]) {
    const subs = findComponents(prob, w, h, t, c.pix).map((pix) => measure(pix, prob, w)).filter(Boolean);
    if (subs.filter((s) => s.len > lineThick * 3).length >= 2 && subs.every((s) => s.thick < lineThick * 1.5)) {
      // Строгий порог «поджимает» строку — возвращаем ей обычную толщину
      for (const s of subs) s.minThick = lineThick;
      return subs;
    }
  }
  return null;
}

function toBox(c, w, sx, sy, src, lineThick) {
  if (c.curved) return curvedBox(c, w, sx, sy, src);
  const { n, mx, my, angle, u0, u1, v0, v1, len, x0, x1 } = c;
  const thick = Math.max(c.thick, c.minThick ?? 0);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const d = (n * UNCLIP_RATIO) / (2 * (len + c.thick)) + (c.minThick ? (thick - c.thick) / 2 : 0);   // как unclip в DBNet
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const cx = (mx + uc * cos - vc * sin) * sx, cy = (my + uc * sin + vc * cos) * sy;
  const L = (len + 2 * d) * sx, H = (c.thick + 2 * d) * sy;
  const ac = Math.abs(cos), as = Math.abs(sin);
  const hw = (L * ac + H * as) / 2, hh = (L * as + H * ac) / 2;
  return {
    cx, cy, L, H, angle,
    x0: Math.max(0, cx - hw), x1: Math.min(src.width, cx + hw), y0: Math.max(0, cy - hh), y1: Math.min(src.height, cy + hh),
    // Текст упирается в край фото — слово может быть обрезано (детектор «поджимает» область)
    edgeL: x0 <= thick * 1.5 + 1, edgeR: x1 >= w - 2 - thick * 1.5,
  };
}

// Строка-дуга: прямоугольник по высоте строки, который при вырезании «едет» по средней линии
function curvedBox(c, w, sx, sy, src) {
  const len = c.x1 - c.x0 + 1;
  const d = (c.n * UNCLIP_RATIO) / (2 * (len + c.colH));
  const yc = centerLine(c);
  let mean = 0;
  for (const y of yc) mean += y;
  mean /= yc.length;
  const L = (len + 2 * d) * sx, H = (c.colH + 2 * d) * sy;
  const cx = ((c.x0 + c.x1 + 1) / 2) * sx, cy = mean * sy;
  return {
    cx, cy, L, H, angle: 0,
    curve: { x0: c.x0, sx, sy, yc },
    x0: Math.max(0, cx - L / 2), x1: Math.min(src.width, cx + L / 2), y0: Math.max(0, cy - H / 2), y1: Math.min(src.height, cy + H / 2),
    edgeL: c.x0 <= c.colH * 1.5 + 1, edgeR: c.x1 >= w - 2 - c.colH * 1.5,
  };
}

// ——— Распознавание одной строки ———

async function recognizeBox({ rec, chars, allowed }, src, b) {
  const tw = Math.max(16, Math.min(3200, Math.ceil((REC_HEIGHT * b.L) / b.H / 8) * 8));
  const c = document.createElement("canvas");
  c.width = tw; c.height = REC_HEIGHT;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, REC_HEIGHT);
  ctx.imageSmoothingQuality = "high";
  if (b.curve) {
    // Изогнутую строку вырезаем узкими полосами вдоль её средней линии — получается прямая строка
    const { x0, sx, sy, yc } = b.curve, step = 4, left = b.cx - b.L / 2;
    for (let dx = 0; dx < tw; dx += step) {
      const srcX = left + (dx / tw) * b.L, srcW = (step / tw) * b.L;
      const i = Math.min(yc.length - 1, Math.max(0, Math.round((srcX + srcW / 2) / sx - x0)));
      ctx.drawImage(src, srcX, yc[i] * sy - b.H / 2, srcW, b.H, dx, 0, step, REC_HEIGHT);
    }
  } else {
    // Вырезаем строку с выпрямлением наклона
    ctx.translate(tw / 2, REC_HEIGHT / 2);
    ctx.scale(tw / b.L, REC_HEIGHT / b.H);
    ctx.rotate(-b.angle);
    ctx.translate(-b.cx, -b.cy);
    ctx.drawImage(src, 0, 0);
  }
  const img = ctx.getImageData(0, 0, tw, REC_HEIGHT);
  const px = img.data, n = tw * REC_HEIGHT;

  // Автоконтраст: растягиваем яркость между 2-м и 98-м процентилем (тени, бледная печать)
  const hist = new Uint32Array(256);
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0; gray[i] = g; hist[g]++; }
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
  const stretch = hi - lo > 40;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const g = stretch ? Math.min(255, Math.max(0, ((gray[i] - lo) * 255) / (hi - lo))) : gray[i];
    const v = (g / 255 - 0.5) / 0.5;
    input[i] = v; input[n + i] = v; input[2 * n + i] = v;
  }
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, REC_HEIGHT, tw]) });
  const t = out[rec.outputNames[0]];
  const [, steps, classes] = t.dims;

  // CTC: лучший разрешённый символ на каждом шаге; запоминаем уверенность и второй вариант
  let text = "", prev = 0;
  const probs = [], alts = [];
  for (let s = 0; s < steps; s++) {
    let best = 0, bestV = -1, second = 0, secondV = -1;
    for (let k = 0; k < classes; k++) {
      if (!allowed[k]) continue;
      const v = t.data[s * classes + k];
      if (v > bestV) { second = best; secondV = bestV; best = k; bestV = v; }
      else if (v > secondV) { second = k; secondV = v; }
    }
    if (best !== 0 && best !== prev) {
      text += chars[best];
      probs.push(bestV);
      alts.push(second ? chars[second] : "");
    } else if (best !== 0 && best === prev && bestV > probs[probs.length - 1]) {
      probs[probs.length - 1] = bestV;
    }
    prev = best;
  }
  return { text, probs, alts };
}

// ——— Чистка текста фрагмента ———

const LAT2CYR = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У", a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у" };
const CYR2LAT = Object.fromEntries(Object.entries(LAT2CYR).map(([l, c]) => [c, l]));
const MIXED_CASE_OK = new Set(["КоАП", "ГрК", "ЖилК"]);

// Буквы в слове приводим к одному алфавиту и одному регистру; длина строки не меняется
function fixWordChars(word) {
  const cyr = (word.match(/[А-Яа-яЁё]/g) || []).length, lat = (word.match(/[A-Za-z]/g) || []).length;
  if (cyr && lat) word = [...word].map((ch) => (cyr >= lat ? LAT2CYR[ch] : CYR2LAT[ch]) ?? ch).join("");
  // «3аказчик» → «Заказчик», «Д0ГОВОР» → «ДОГОВОР»: цифры 0/3 внутри слова из букв
  if (/\d/.test(word) && (word.match(/[^\dоОзЗ\P{L}]/gu) || []).length >= 2) {
    const upper = word === word.toUpperCase();
    word = word.replace(/0/g, upper ? "О" : "о").replace(/3/g, upper ? "З" : "з");
  }
  const letters = word.replace(/\P{L}/gu, "");
  if (letters.length < 2 || MIXED_CASE_OK.has(word)) return word;
  // «дальнейшемПокупатель» или «ИзложЕнного» — решаем позже, по словарю (polishLine)
  if (/\p{Ll}{2}\p{Lu}\p{Ll}{2}/u.test(word)) return word;
  const U = (letters.match(/\p{Lu}/gu) || []).length, Lw = letters.length - U;
  if (!U || !Lw) return word;
  if (U > Lw) return word.toUpperCase();                                   // «ДОгОВОР» → «ДОГОВОР»
  if (/^\P{L}*\p{Lu}/u.test(word)) return word.replace(/\p{L}+/u, (s) => s[0] + s.slice(1).toLowerCase());  // «АрендаТор»
  return word.toLowerCase();                                                // «догоВор»
}

function cleanFragment({ text, probs, alts }, info) {
  let t = text;
  // Латинские буквы в инициалах русского текста: «Т.B.» → «Т.В.»
  const cyr = (t.match(/[А-Яа-яЁё]/g) || []).length, lat = (t.match(/[A-Za-z]/g) || []).length;
  if (cyr > lat * 2) t = t.replace(/(?<![A-Za-z])[ABCEHKMOPTXY](?=\.)/g, (ch) => LAT2CYR[ch]);
  // «ЛыжовС.В.» — фамилия слиплась с инициалами
  const insertAt = [];
  t.replace(/\p{Ll}(?=\p{Lu}\.\s?\p{Lu}\.)/gu, (m, off) => { insertAt.push(off + 1); return m; });
  for (const pos of insertAt.reverse()) {
    t = t.slice(0, pos) + " " + t.slice(pos);
    probs.splice(pos, 0, 1); alts.splice(pos, 0, "");
  }
  // Посимвольно сохраняем длину, чтобы уверенность модели оставалась привязана к буквам
  t = t.replace(/[\p{L}\d]+/gu, (w) => fixWordChars(w));
  t.replace(/\p{L}+/gu, (w, off) => {
    const p = probs.slice(off, off + w.length), a = alts.slice(off, off + w.length);
    const key = norm(w), prev = info.get(key);
    const minP = Math.min(...p);
    if (!prev || minP < prev.minP) info.set(key, { minP, probs: p, alts: a, word: w });
    return w;
  });
  return fixDigits(t.replace(/\s+/g, " ").trim());
}

// Модель путает 0/3 с кириллическими о/з: в числах («120 о00», «о,1 %») возвращаем цифры
function fixDigits(text) {
  return text.replace(/(?<!\p{L})[\dоОзЗ.,:/%-]+(?!\p{L})/gu, (tok) =>
    /\d/.test(tok) && /^[\dоОзЗ]+([.,:/-][\dоОзЗ]+)*[.,%]?$/.test(tok)
      ? tok.replace(/[оО]/g, "0").replace(/[зЗ]/g, "3")
      : tok);
}

// ——— Словарь: частотный список русских слов (FrequencyWords, CC BY-SA 4.0) ———

// плюс ~1,2 млн редких словоформ (danakt/russian-words) — только для проверки, что слово существует.
// forms.txt хранится сжато: первый символ строки — сколько букв взять из предыдущего слова (код − 48).

let wordsPromiseCache = null;
export function loadWords() {
  if (!wordsPromiseCache) {
    const get = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
    wordsPromiseCache = Promise.all([get("models/words.txt"), get("models/forms.txt")])
      .then(([freq, forms]) => {
        const list = freq.split("\n").filter(Boolean).map(norm);   // по убыванию частоты
        const set = new Set(list);
        let prev = "";
        for (const line of forms.split("\n")) {
          if (!line) continue;
          prev = prev.slice(0, line.charCodeAt(0) - 48) + line.slice(1);
          set.add(prev);
        }
        return { list, set, rank: new Map(list.map((w, i) => [w, i])) };
      })
      .catch((e) => { wordsPromiseCache = null; throw e; });
  }
  return wordsPromiseCache;
}

const norm = (w) => w.toLowerCase().replace(/ё/g, "е");
const isWord = (w, words, vocab) => inDict(norm(w), words) || (vocab?.get(norm(w)) ?? 0) > 1;
// Есть в словаре — напрямую, через приставку или как существительное от прилагательного
const inDict = (lw, words) => words.set.has(lw) || prefixed(lw, words) || derived(lw, words);
// «подчиняемости» от «подчиняемый», «лабильности» от «лабильный»: таких терминов в словарях часто нет
const OST = ["остями", "остью", "остей", "остям", "остях", "ость", "ости"];
function derived(lw, words) {
  for (const suf of OST) {
    if (!lw.endsWith(suf) || lw.length - suf.length < 4) continue;
    const stem = lw.slice(0, -suf.length);
    return words.set.has(stem + "ый") || words.set.has(stem + "ий") || words.set.has(stem + "ой");
  }
  return false;
}
// Слово из приставки и словарного слова: «психотравмирующей», «подэкспертная»
// («не», «без» сюда не входят: «несопровождаются» — это два слова, а «неисполнения» и так есть в словаре)
const PREFIXES = ["психо", "сверх", "само", "взаимо", "много", "меж", "анти", "квази", "контр", "гипер", "полу", "микро", "макро", "под", "пред", "пере"];
function prefixed(lw, words) {
  for (const p of PREFIXES) if (lw.length - p.length >= 5 && lw.startsWith(p) && words.set.has(lw.slice(p.length))) return true;
  return false;
}
// У края фото обрывок легко совпадает с редким словом («оди»), поэтому целым считаем только достаточно частое
function isEdgeWord(w, words, vocab) {
  const rank = words.rank.get(norm(w));
  return (rank !== undefined && rank < (w.length <= 3 ? 3000 : 150000)) || (vocab.get(norm(w)) ?? 0) > 1;
}

// Слова, которые встречаются в самом документе, — лучшие кандидаты для достройки
function docVocabulary(lines) {
  const vocab = new Map();
  for (const l of lines) {
    const ws = l.text.match(/\p{L}{3,}/gu) || [];
    // Слово у края фото может быть обрывком («догово» в каждой строке) — повторы обрывков словом не делают
    if (l.edgeR && /\p{L}$/u.test(l.text)) ws.pop();
    if (l.edgeL && /^\p{L}/u.test(l.text)) ws.shift();
    for (const w of ws) vocab.set(norm(w), (vocab.get(norm(w)) || 0) + 1);
  }
  return vocab;
}

// Подгоняет регистр подставленных букв под видимую часть слова
function matchCase(visible, missing) {
  return visible.length > 1 && visible === visible.toUpperCase() ? missing.toUpperCase() : missing;
}
function applyCase(model, word) {
  if (model.length > 1 && model === model.toUpperCase()) return word.toUpperCase();
  if (/^\p{Lu}/u.test(model)) return word[0].toUpperCase() + word.slice(1);
  return word;
}

// Варианты достройки для подсказок: «сторона:видимая часть» → полные слова (заполняется при каждом распознавании)
const guessAlts = new Map();

// Слово обрезано правым краем фото: «Арендода» → «Арендода[тель?]».
// soft — край строки, а не фото (изгиб страницы): трогаем только явный обрывок, иначе слово проверит словарь
function completeEnd(text, words, vocab, soft = false) {
  if (!soft) text = text.replace(/(\p{L})[|/\\'`([]$/u, "$1");   // осколок срезанной буквы
  if (!soft && !text.includes("(")) text = text.replace(/(\p{L})\)$/u, "$1");   // «Арендо)» — скобка без пары тоже осколок
  const m = text.match(/(\p{L}+)$/u);
  if (!m || isEdgeWord(m[1], words, vocab)) return text;
  if (soft && (m[1].length < 3 || !/^\p{Ll}+$/u.test(m[1]) || isWord(m[1], words, vocab))) return text;
  const part = norm(m[1]);
  if (part.length < 2) return text + "[…]";
  let list = topCandidates(part, (w) => w.startsWith(part), words, vocab);
  if (!list.length && soft) list = shortCompletions(part, words, "end");
  if (!list.length && soft) return text;
  guessAlts.set("end:" + part, list.map((w) => m[1] + matchCase(m[1], w.slice(part.length))));
  return text + (list.length ? `[${matchCase(m[1], list[0].slice(part.length))}?]` : "[…]");
}

// Слово обрезано левым краем фото: «датель» → «[арендо?]датель»
function completeStart(text, words, vocab, soft = false) {
  if (!soft) text = text.replace(/^[|/\\'`!([](?=\p{L})/u, "");   // осколок срезанной буквы
  const m = text.match(/^(\p{L}+)/u);
  if (!m || isEdgeWord(m[1], words, vocab)) return text;
  if (soft && (m[1].length < 3 || !/^\p{Ll}+$/u.test(m[1]) || isWord(m[1], words, vocab))) return text;
  const part = norm(m[1]);
  if (part.length < 3) return "[…]" + text;
  let list = topCandidates(part, (w) => w.endsWith(part), words, vocab);
  if (!list.length && soft) list = shortCompletions(part, words, "start");
  if (!list.length && soft) return text;
  guessAlts.set("start:" + part, list.map((w) => matchCase(m[1], w.slice(0, w.length - part.length)) + m[1]));
  return (list.length ? `[${matchCase(m[1], list[0].slice(0, list[0].length - part.length))}?]` : "[…]") + text;
}

// Редкое слово, которого нет в частотном списке: перебираем 1–2 недостающие буквы по полному словарю
function shortCompletions(part, words, side) {
  if (part.length < 5) return [];
  const rank = (x) => words.rank.get(x) ?? words.list.length;
  const found = [];
  const tryAdd = (add) => { const cand = side === "start" ? add + part : part + add; if (inDict(cand, words)) found.push(cand); };
  for (const a of RU) tryAdd(a);
  if (!found.length) for (const a of RU) for (const b of RU) tryAdd(a + b);
  return found.sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, 6);
}

// Лучшие слова, содержащие видимую часть: частые, встречаются в документе, не слишком длинные.
// Чем длиннее видимая часть, тем больше доверяем словам из самого документа.
function topCandidates(part, fits, words, vocab, n = 6) {
  const docWeight = part.length >= 6 ? 3 : 0.5;
  // Краем обычно срезана пара букв, поэтому длинные дописки «дороже»
  const score = (w, rank) => Math.log(rank + 50) + 0.2 * (w.length - part.length) - docWeight * Math.log(1 + (vocab.get(w) ?? 0));
  const top = [];   // [score, word], по возрастанию
  const consider = (w, rank) => {
    if (w.length <= part.length || !fits(w)) return;
    const s = score(w, rank);
    if (top.length === n && s >= top[n - 1][0]) return;
    top.push([s, w]); top.sort((a, b) => a[0] - b[0]); if (top.length > n) top.pop();
  };
  words.list.forEach(consider);
  for (const w of vocab.keys()) if (!words.set.has(w)) consider(w, words.list.length);
  const list = top.map(([, w]) => w);
  // Слова из самого документа всегда среди вариантов (сразу после лучшего)
  const fromDoc = [...vocab.keys()].filter((w) => w.length > part.length && fits(w) && !list.includes(w)).slice(0, 2);
  return list.length ? [list[0], ...fromDoc, ...list.slice(1)].slice(0, n) : fromDoc;
}

// Склеивает слова, разорванные переносом: «догово-» + «ра» → «договора»
const tail = (s) => s.match(/^\p{L}+/u)[0];
function joinHyphens(out, words, vocab) {
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i].match(/(\p{L}+)[-‐‑¬]$/u);
    const b = out[i + 1].match(/^(\p{Ll}+[.,;:!?»)]*)(.*)$/u);
    if (!a || !b) continue;
    let joined;
    if (!words) joined = b[1];
    else if (isWord(a[1] + tail(b[1]), words, vocab)) joined = b[1];                             // обычный перенос
    else if (isWord(a[1], words, vocab) && isWord(tail(b[1]), words, vocab)) joined = "-" + b[1];  // «приёма-передачи»
    else joined = b[1];
    out[i] = out[i].slice(0, -1) + joined;
    const rest = b[2].trimStart();
    if (rest) out[i + 1] = rest;
    else { out.splice(i + 1, 1); out.boxes?.splice(i + 1, 1); }
  }
  return out;
}

// ——— Финальная вычитка строки: пунктуация, кавычки, слова по словарю ———

// Короткие слова, которые часто «прилипают»: слева — предлоги и союзы, справа — частицы
const LEFT_SHORT = new Set(["в", "с", "к", "о", "у", "и", "а", "на", "по", "за", "до", "от", "из", "не", "об", "со", "при", "для", "без", "под", "над", "про", "что", "как"]);
const RIGHT_SHORT = new Set(["ли", "же", "бы"]);

function polishLine(line, words, vocab, info) {
  if (!line) return line;
  // Непарная прямая кавычка — обычно росчерк подписи или край печати (убираем до расстановки пробелов)
  for (const q of ['"', "'"]) if ((line.split(q).length - 1) % 2) line = line.split(q).join("");
  let s = line
    .replace(/\s+([,.;:!?)»])/g, "$1")                 // «слово ,» → «слово,»
    .replace(/([,;:])\1+/g, "$1").replace(/(?<!\.)\.\.(?!\.)/g, ".")   // «оценки,,» → «оценки,» (многоточие не трогаем)
    .replace(/([(«])\s+/g, "$1")                         // «( слово» → «(слово»
    .replace(/([,;)])(?=[\p{L}«(])/gu, "$1 ")           // «Продавец»,с» → «Продавец», с»; «)не» → «) не»
    .replace(/(\d\.)(?=\p{Lu}\p{L})/gu, "$1 ")           // «4.ОТВЕТСТВЕННОСТЬ» → «4. ОТВЕТСТВЕННОСТЬ»
    .replace(/(\p{Ll}{2}[.!?])(?=\p{Lu}[\p{Ll}\s])/gu, "$1 ") // «сторон.Покупатель», «делу.В» → с пробелом
    .replace(/(\p{Lu}\.\s?\p{Lu}\.)(?=\p{L})/gu, "$1 ")    // «Т.В.не» → «Т.В. не»
    .replace(/(\p{L}{4})\/(?=\p{L}{4})/gu, "$1 ")          // «медицинского/характера» — косая черта от росчерка
    .replace(/(\d)[-.–\s]{0,3}ф[з3](?![\p{L}\d])/giu, "$1-ФЗ")         // «129.-ф3» → «129-ФЗ»
    .replace(/ {2,}/g, " ");
  s = balanceQuotes(s).replace(/ {2,}/g, " ").trim();
  if (!words) return s;
  // Догадки у края фото и изгиба («[тель?]», «[…]») не трогаем
  return markGuesses(s.split(/(\[[^\]]*\?\]|\[…\])/u).map((seg, i, all) => (i % 2 ? seg : seg.replace(/\p{L}+(?:-\p{L}+)*/gu, (w, off, str) => {
    // Видимая часть слова, обрезанного краем («[арендо?]датель»), уже обработана — не трогаем
    if ((off === 0 && i > 0) || (off + w.length === str.length && i < all.length - 1)) return w;
    w = fixCamel(w, words, vocab);
    if (w.includes(" ")) return mark(w, "fix", [w.replace(" ", "")]);
    // Имя или название: с заглавной не в начале предложения или рядом с инициалами («Чернявская Г.Ю.»)
    const before = (i ? "x" : "") + str.slice(0, off), after = str.slice(off + w.length);
    const initials = /^\s*\p{Lu}\.\s?\p{Lu}\./u.test(after) || /\p{Lu}\.\s?\p{Lu}\.\s*$/u.test(before);
    const name = /^\p{Lu}\p{Ll}/u.test(w) && w.length <= 15 && (initials || /[\p{L}\d,;:«(]\s*$/u.test(before));
    // Первое и последнее слово строки: у изгиба страницы их край мог уйти в переплёт
    const edge = { start: i === 0 && off === 0, end: i === all.length - 1 && /^[^\p{L}\d]*$/u.test(after) };
    const checked = checkWord(w, words, vocab, info, name, edge);
    // Фамилии и отчества помечаем на проверку: ошибка в них в юридическом тексте критична
    // Имя перед отчеством («Анна Сергеевна») — тоже часть ФИО
    const firstName = /^\s*\p{Lu}\p{Ll}+(?:ович|евич|овн|евн|ичн)/u.test(after);
    return checked === w && name && personName(w, initials || firstName, words) ? mark(w, "name", []) : checked;
  }))).join(""));
}

// Похоже на фамилию или отчество: рядом инициалы («Иванов И.И.») или типичное окончание
// («Петрову», «Чернявская», «Сергеевича»). Прилагательные из словаря («Российской») не считаем.
const SURNAME_RE = /(?:[оеё]в|[иы]н)(?:а|у|ым|ой|ою|е|ы|ых|ыми)?$|(?:ск|цк)(?:ий|ого|ому|им|ом|ая|ой|ую|ие|их)$|(?:енко|ук|юк|ян|янц|швили|дзе|ых|их)$/u;
const PATRONYMIC_RE = /(?:ович|евич|овн|евн|ичн)(?:а|у|ем|е|ом|ой|ою|ы)?$/u;
const NOT_NAMES = new Set(["договор", "договоров", "закон", "кодекс", "суд", "сторон", "гражданин", "гражданина", "гражданину", "гражданином", "москва", "москвы", "россии", "российской", "федерации"]);
function personName(w, initials, words) {
  const lw = norm(w);
  if (lw.length < 4 || NOT_NAMES.has(lw)) return false;
  if (initials) return true;
  if (PATRONYMIC_RE.test(lw)) return true;
  if (!SURNAME_RE.test(lw)) return false;
  // Прилагательные и обычные слова на «-ский», «-ых»: «Российской», «Московских» — не фамилии
  if (/(?:ск|цк)/u.test(lw.slice(-5)) || /(?:ых|их)$/u.test(lw)) return !inDict(lw, words);
  return true;
}

// Достроенные слова («[дей?]ствительности», «Арендода[тель?]», «[…]ра») размечаем как «guess» с вариантами,
// чтобы их тоже можно было выбрать при наведении
function markGuesses(s) {
  // Внутрь уже размеченных слов не заходим
  return s.split(/([^]*)/u).map((part, i) => (i % 2 ? part : part.replace(/\[([^\]]*)\?\](\p{L}+)|(\p{L}+)\[([^\]]*)\?\]|(\p{L}*)\[…\](\p{L}*)/gu, (all, g1, visStart, visEnd) => {
    let alts = [];
    if (visStart) alts = guessAlts.get("start:" + norm(visStart)) || [];
    else if (visEnd) alts = guessAlts.get("end:" + norm(visEnd)) || [];
    return mark(all, "guess", alts);
  }))).join("");
}

// Смена регистра внутри слова: «ИзложЕнного» — одно слово, «дальнейшемПокупатель» — два
function fixCamel(w, words, vocab) {
  const m = w.match(/^(.*\p{Ll}{2})(\p{Lu}\p{Ll}{2}.*)$/u);
  if (!m) return w;
  const whole = /^\p{Lu}/u.test(w) ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase();
  if (isWord(whole, words, vocab)) return whole;
  if (isWord(m[1], words, vocab) && isWord(m[2], words, vocab)) return m[1] + " " + m[2];
  return whole;
}

// Потерянная открывающая кавычка: «именуемая в дальнейшем Покупатель»» → «…«Покупатель»»
function balanceQuotes(s) {
  let open = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "«") open++;
    else if (s[i] === "»") {
      if (open > 0) { open--; continue; }
      const m = s.slice(0, i).match(/(\p{L}+)$/u);
      if (m) { s = s.slice(0, i - m[1].length) + "«" + s.slice(i - m[1].length); i++; }
    }
  }
  return s;
}

const mark = (shown, kind, alts) => M_OPEN + shown + M_SEP + kind + M_SEP + alts.filter((a) => a !== shown).join("|") + M_CLOSE;
const RU = "абвгдежзийклмнопрстуфхцчшщъыьэюя";

function checkWord(w, words, vocab, info, name = false, edge = {}) {
  if (w.includes("-")) {
    if (isWord(w, words, vocab)) return w;
    const parts = w.split("-");
    if (parts.every((p) => isWord(p, words, vocab) || p.length < 2)) return w;
    return parts.map((p) => (p.length < 3 ? p : checkWord(p, words, vocab, info, name))).join("-");
  }
  if (w.length < 3 || /[A-Za-z]/.test(w)) return w;
  if (w.length <= 6 && w === w.toUpperCase() && !isWord(w, words, vocab)) return w;   // аббревиатуры: УФМС, ЕГРН
  const meta = info.get(norm(w));
  const minP = meta?.minP ?? 1;
  const rank = (x) => words.rank.get(norm(x)) ?? words.list.length;

  if (!isWord(w, words, vocab)) {
    // Слово, которое в этом документе встречается ещё не раз, отличается одной буквой: «Захардва» → «Захарова»
    const twin = docTwin(w, vocab);
    if (twin) return mark(applyCase(w, twin), "fix", [w]);
    // Термин документа в другой форме («подэкспертная» при «подэкспертной») — не делим и не «чиним»
    if (docStem(w, vocab)) return w;
  }
  // Имена и фамилии: в словаре их может не быть, словарные подсказки для них бесполезны
  if (name && !isWord(w, words, vocab)) return minP < 0.5 ? mark(w, "unk", []) : w;
  if (name && minP >= 0.6) return w;
  if (isWord(w, words, vocab)) {
    if (minP >= 0.45) return w;
    // Слово есть в словаре, но модель сильно сомневалась — показываем альтернативы, если они тоже слова
    const others = ctcVariants(w, meta).filter((v) => norm(v) !== norm(w) && isWord(v, words, vocab));
    return others.length ? mark(w, "unk", others.slice(0, 4)) : w;
  }

  // Больше трети букв прочитано неуверенно — это «каша», автоматически ничего не подставляем
  const mush = meta && meta.word.length === w.length && meta.probs.filter((p) => p < 0.7).length > w.length / 3;
  // 1) второй по уверенности вариант модели даёт словарное слово
  const fromModel = ctcVariants(w, meta).filter((v) => isWord(v, words, vocab)).sort((a, b) => rank(a) - rank(b));
  // 2) слово с пропущенным пробелом: «настоящемудоговору» (имена и названия не делим: «Татарстан»)
  const split = name || mush ? null : splitGlued(w, words);
  // 3) похожие словарные слова (1–2 опечатки), с учётом уверенности модели в заменяемых буквах
  const near = nearWords(w, meta, words, vocab);

  if (mush) {
    const alts = uniq([...fromModel, ...near.map((c) => c.word)]).slice(0, 5);
    return mark(w, "unk", alts);
  }
  if (fromModel.length && rank(fromModel[0]) < words.list.length) return mark(fromModel[0], "fix", uniq([w, ...fromModel.slice(1), ...near.map((c) => c.word)]).slice(0, 5));
  if (split) return mark(split, "fix", uniq([w, ...near.map((c) => c.word)]).slice(0, 5));
  if (fromModel.length) return mark(w, "unk", uniq([...fromModel, ...near.map((c) => c.word)]).slice(0, 5));
  if (near.length && near[0].auto && (!name || near[0].cost < 0.7)) return mark(near[0].word, "fix", uniq([w, ...near.slice(1).map((c) => c.word)]).slice(0, 5));
  // Слиплись слова и край последнего (первого) ушёл в изгиб: «особенностейиэмоциональног»
  if ((edge.end || edge.start) && !name && w.length >= 6) {
    const se = splitEdge(w, words, vocab, edge.end);
    if (se) return mark(se.shown, "guess", se.alts);
  }
  if (near.length) return mark(w, "unk", near.slice(0, 5).map((c) => c.word));
  // Не словарное и без похожих: термин, обрывок или неразборчиво. Длинные такие слова показываем на проверку
  if (minP < 0.6 || w.length >= 7) return mark(w, "unk", fragmentCandidates(w, words));
  return w;
}

const uniq = (a) => [...new Set(a)];

// Слова, частью которых может быть обрывок: «дчиняемости» → «подчиняемости»
function fragmentCandidates(w, words) {
  const lw = norm(w);
  if (lw.length < 4) return [];
  const out = [...shortCompletions(lw, words, "start"), ...shortCompletions(lw, words, "end")];
  const limit = Math.min(words.list.length, 300000);
  for (let k = 0; k < limit && out.length < 6; k++) {
    const c = words.list[k];
    if (c.length > lw.length && c.length <= lw.length + 4 && (c.endsWith(lw) || c.startsWith(lw))) out.push(c);
  }
  return uniq(out).slice(0, 6).map((c) => applyCase(w, c));
}

// Слипшиеся слова, у которых край ушёл в изгиб страницы. atEnd — обрезан конец (слово в конце строки),
// иначе начало. Ищем самый длинный обрывок, который можно достроить, а остальное делим на слова.
function splitEdge(w, words, vocab, atEnd) {
  const n = w.length;
  for (let len = n - 3; len >= 1; len--) {
    const piece = atEnd ? w.slice(n - len) : w.slice(0, len);
    const rest = atEnd ? w.slice(0, n - len) : w.slice(len);
    if (!/^\p{L}+$/u.test(piece)) continue;
    const restWords = rest.length < 4 ? null : isWord(rest, words, vocab) ? rest : splitGlued(rest, words);
    if (!restWords) continue;
    const lp = norm(piece);
    const comps = (len >= 3 ? topCandidates(lp, (c) => (atEnd ? c.startsWith(lp) : c.endsWith(lp)), words, vocab) : [])
      .concat(len >= 1 && len < 3 ? longerForms(lp, words, (c) => (atEnd ? c.startsWith(lp) : c.endsWith(lp))).slice(0, 6) : []);
    if (!comps.length) continue;
    const full = comps.map((c) => (atEnd ? piece + matchCase(piece, c.slice(lp.length)) : matchCase(piece, c.slice(0, c.length - lp.length)) + piece));
    const shown = atEnd ? `${restWords} ${piece}[${full[0].slice(piece.length)}?]` : `[${full[0].slice(0, full[0].length - piece.length)}?]${piece} ${restWords}`;
    return { shown, alts: full.map((f) => (atEnd ? `${restWords} ${f}` : `${f} ${restWords}`)) };
  }
  return null;
}

function docTwin(w, vocab) {
  const lw = norm(w);
  if (lw.length < 5) return null;
  for (const [v, count] of vocab) {
    // Только замена буквы: удаление съело бы предлог в «впериод»
    if (count < 2 || v === lw || v.length !== lw.length) continue;
    if (editDistance(lw, v, 1) <= 1) return v;
  }
  return null;
}
function docStem(w, vocab) {
  const lw = norm(w);
  if (lw.length < 8) return false;
  const stem = lw.slice(0, lw.length - 3);
  for (const [v, count] of vocab) if (count >= 2 && v !== lw && v.startsWith(stem)) return true;
  return false;
}

// Варианты слова, где сомнительные буквы заменены на второй вариант модели
function ctcVariants(w, meta) {
  if (!meta || meta.word.length !== w.length) return [];
  const weak = meta.probs.map((p, i) => [p, i]).filter(([p, i]) => p < 0.9 && /\p{L}/u.test(meta.alts[i] || "")).sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, i]) => i);
  const out = [];
  for (let mask = 1; mask < 1 << weak.length; mask++) {
    const chars = [...w];
    weak.forEach((pos, bit) => { if (mask & (1 << bit)) chars[pos] = matchCaseChar(chars[pos], meta.alts[pos]); });
    out.push(chars.join(""));
  }
  return out;
}
const matchCaseChar = (orig, ch) => (orig === orig.toUpperCase() ? ch.toUpperCase() : ch.toLowerCase());

// Разбивка на 2–3 слова: «лишалиееспособности» → «лишали ее способности».
// Длинные части (от 5 букв) — любое словарное слово, короткие — только частые.
function splitGlued(w, words) {
  if (w.length < 5) return null;
  const lw = norm(w), n = lw.length;
  const cost = (seg, isFirst, isLast) => {
    if (seg.length >= 5) return words.set.has(seg) ? Math.log((words.rank.get(seg) ?? 300000) + 50) : null;
    if (seg === "и" || seg === "а") return 3;                    // «сознаниеи» → «сознание и»
    if (seg.length === 1) return isFirst && LEFT_SHORT.has(seg) ? 3 : null;
    if (isFirst && LEFT_SHORT.has(seg)) return 3;
    if (isLast && RIGHT_SHORT.has(seg)) return 3;
    const r = words.rank.get(seg);
    return r !== undefined && r < (seg.length === 4 ? 20000 : 5000) ? Math.log(r + 50) : null;
  };
  // best[i] — лучшая разбивка префикса длины i: { score, cuts }
  const best = [{ score: 0, cuts: [] }];
  for (let i = 1; i <= n; i++) {
    for (let j = 0; j < i; j++) {
      if (!best[j] || best[j].cuts.length >= 2 && i !== n) continue;
      const c = cost(lw.slice(j, i), j === 0, i === n);
      if (c === null) continue;
      const score = best[j].score + c + 4;   // каждый пробел «стоит», чтобы не дробить без нужды
      if (!best[i] || score < best[i].score) best[i] = { score, cuts: [...best[j].cuts, j] };
    }
  }
  const res = best[n];
  if (!res || res.cuts.length < 2 || res.cuts.length > 3) return null;
  const cuts = [...res.cuts.slice(1), n];
  let out = "", prev = 0;
  for (const c of cuts) { out += (out ? " " : "") + w.slice(prev, c); prev = c; }
  return out;
}

// Словарные слова на расстоянии 1–2 правок. Замена буквы, в которой модель была уверена, «дорогая».
function nearWords(w, meta, words, vocab) {
  const lw = norm(w);
  const pOf = (i) => (meta && meta.word.length === w.length ? meta.probs[i] : 0.7);
  const found = new Map();   // слово → цена правок
  const add = (cand, cost) => {
    if (cand === lw || !words.set.has(cand) && !(vocab.get(cand) > 1)) return;
    if (!found.has(cand) || found.get(cand) > cost) found.set(cand, cost);
  };
  for (let i = 0; i < lw.length; i++) {
    add(lw.slice(0, i) + lw.slice(i + 1), 0.5 + pOf(i));                       // лишняя буква
    for (const ch of RU) {
      add(lw.slice(0, i) + ch + lw.slice(i + 1), pOf(i));                       // замена
      add(lw.slice(0, i) + ch + lw.slice(i), 0.6);                              // пропущенная буква
    }
    if (i < lw.length - 1) add(lw.slice(0, i) + lw[i + 1] + lw[i] + lw.slice(i + 2), 0.8);   // перестановка
  }
  if (lw.length >= 6) {
    // Две замены — только в буквах, где модель сомневалась
    const weak = [...lw].map((_, i) => i).filter((i) => pOf(i) < 0.95);
    for (let a = 0; a < weak.length; a++) for (let b = a + 1; b < weak.length; b++) {
      const i = weak[a], j = weak[b];
      for (const c1 of RU) for (const c2 of RU) {
        add(lw.slice(0, i) + c1 + lw.slice(i + 1, j) + c2 + lw.slice(j + 1), pOf(i) + pOf(j));
      }
    }
  }
  // Любые две правки (пропуск + замена и т. п.) — перебором частых слов похожей длины
  if (lw.length >= 4) {
    const limit = Math.min(words.list.length, 150000);
    for (let k = 0; k < limit; k++) {
      const cand = words.list[k];
      if (Math.abs(cand.length - lw.length) > 2 || found.has(cand)) continue;
      const d = editDistance(lw, cand, 2);
      if (d === 2) found.set(cand, 1.6);
    }
  }
  const rank = (x) => words.rank.get(x) ?? words.list.length;
  return [...found]
    .map(([cand, cost]) => ({ word: applyCase(w, cand), cost, score: cost * 2 + Math.log(rank(cand) + 50) * 0.5 - Math.log(1 + (vocab.get(cand) ?? 0)) }))
    .sort((a, b) => a.score - b.score)
    .map((c, i, arr) => {
      const gap = arr.length < 2 ? Infinity : arr[1].score - c.score;
      // Модель сомневалась в заменяемой букве — или слово длинное, правка одна и других близких вариантов нет
      const auto = i === 0 && ((c.cost < 1.0 && gap > 0.6) || (lw.length >= 6 && c.cost <= 1.5 && gap > 1.0));
      return { ...c, auto };
    });
}

// Расстояние Левенштейна с ранним выходом: больше max — возвращает max + 1
function editDistance(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ——— Контекст: какие слова и окончания стоят рядом в юридических текстах ———
// ctx.txt собран из кодексов РФ (.tools/build-ctx.cjs): «w слово1 слово2 N» и «e конец1 конец2 N».

const FUNC_WORDS = new Set("в во на по за до от из у с со к ко о об обо при для без под над про через между перед после и а но или либо не ни что как чтобы если когда же ли бы то это его ее их ему ей им который которая которое которые которого которой которых".split(" "));
const ending = (w) => (FUNC_WORDS.has(w) || w.length <= 3 ? "=" + w : w.slice(-3));

let ctxPromise = null;
export function loadContext() {
  if (!ctxPromise) {
    ctxPromise = fetch("models/ctx.txt")
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then((t) => {
        const w = new Map(), e = new Map(), leftTot = new Map(), rightTot = new Map();
        for (const line of t.split("\n")) {
          const [kind, a, b, n] = line.split(" ");
          if (!n) continue;
          if (kind === "w") w.set(a + " " + b, +n);
          else {
            e.set(a + " " + b, +n);
            leftTot.set(b, (leftTot.get(b) || 0) + +n);    // сколько раз окончание b шло после чего-либо
            rightTot.set(a, (rightTot.get(a) || 0) + +n);   // сколько раз после окончания a что-то шло
          }
        }
        return { w, e, leftTot, rightTot };
      })
      .catch((err) => { ctxPromise = null; throw err; });
  }
  return ctxPromise;
}

// Насколько слово подходит между соседями: частота слова × согласование окончаний × известные пары слов
function ctxScore(cand, prev, next, words, vocab, ctx) {
  const c = norm(cand), ec = ending(c);
  const EW = 0.5, WW = 1.5;   // окончания по малому корпусу шумные — им меньший вес, чем известным парам слов
  let s = -0.5 * Math.log((words.rank.get(c) ?? words.list.length) + 50) + 0.5 * Math.log(1 + (vocab.get(c) ?? 0));
  if (prev) {
    const p = norm(prev);
    s += EW * Math.log(((ctx.e.get(ending(p) + " " + ec) ?? 0) + 0.1) / ((ctx.leftTot.get(ec) ?? 0) + 10));
    s += WW * Math.log(1 + (ctx.w.get(p + " " + c) ?? 0));
  }
  if (next) {
    const n = norm(next);
    s += EW * Math.log(((ctx.e.get(ec + " " + ending(n)) ?? 0) + 0.1) / ((ctx.rightTot.get(ec) ?? 0) + 10));
    s += WW * Math.log(1 + (ctx.w.get(c + " " + n) ?? 0));
  }
  return s;
}

const TOKEN_RE = /([^]*)(\w+)([^]*)|\p{L}+(?:-\p{L}+)*/gu;
const GUESS_RE = /^\[([^\]]*)\?\](\p{L}+)$|^(\p{L}+)\[([^\]]*)\?\]$/u;

// Проход по всей странице: варианты сортируются по соседям, а у краёв строк предлагаются
// формы слова, которые лучше согласуются с контекстом («в полной мер» → «мер[е?]»)
function applyContext(page, words, vocab, ctx) {
  const toks = [];
  for (const m of page.matchAll(TOKEN_RE)) {
    const t = { start: m.index, end: m.index + m[0].length };
    if (m[1] !== undefined) Object.assign(t, { kind: m[2], shown: m[1], alts: m[3] ? m[3].split("|") : [] });
    else t.shown = m[0];
    t.plain = t.shown.replace(/\[[^\]]*\]/g, "");
    toks.push(t);
  }
  // Соседи считаются связанными, только если между ними пробел (знак препинания или абзац рвёт связь)
  const linked = (a, b) => /^[ \n]$/.test(page.slice(a.end, b.start));
  // Сосед-догадка участвует своим лучшим вариантом
  const ctxWord = (t) => (!t ? null : t.kind === "guess" ? t.alts[0] || null : t.shown);
  const rewrite = [];

  toks.forEach((t, i) => {
    const prevT = i > 0 && linked(toks[i - 1], t) ? toks[i - 1] : null;
    const nextT = i < toks.length - 1 && linked(t, toks[i + 1]) ? toks[i + 1] : null;
    const prev = ctxWord(prevT), next = ctxWord(nextT);
    if (!prev && !next) return;
    const score = (w) => ctxScore(w, prev, next, words, vocab, ctx);
    const byScore = (list) => [...list].sort((a, b) => score(b) - score(a));

    if (t.kind === "guess") {
      const g = t.shown.match(GUESS_RE);
      if (!g || !t.alts.length) return;
      // Показанную догадку меняем, только если контекст явно за другой вариант; остальные — по контексту
      const first = t.alts[0], others = byScore(t.alts.slice(1));
      const best = others.length && score(others[0]) - score(first) > 4 ? others[0] : first;
      const alts = [best, ...[first, ...others].filter((a) => a !== best)];
      const shown = g[2] ? `[${best.slice(0, best.length - g[2].length)}?]${g[2]}` : `${g[3]}[${best.slice(g[3].length)}?]`;
      rewrite.push([t, mark(shown, "guess", alts)]);
    } else if (t.kind === "unk" && t.alts.length > 1) {
      rewrite.push([t, mark(t.shown, "unk", byScore(t.alts))]);
    } else if (t.kind === "fix" && t.alts.length > 1) {
      // Исправленное слово не меняем (так точнее), но другие варианты сортируем по контексту
      const orig = t.alts[0];
      rewrite.push([t, mark(t.shown, "fix", [orig, ...byScore(t.alts.slice(1))])]);
    } else if (!t.kind && /^\p{Ll}+$/u.test(t.shown)) {
      const lw = norm(t.shown);
      const atLineEnd = page[t.end] === "\n" && page[t.end + 1] && page[t.end + 1] !== "\n";
      const atLineStart = page[t.start - 1] === "\n" && i > 0;
      let cands = [];
      // У края строки слово могло уйти в изгиб страницы: «в полной мер» → «мере»
      if (atLineEnd && lw.length >= 2) cands = longerForms(lw, words, (w) => w.startsWith(lw));
      else if (atLineStart && lw.length >= 3) cands = longerForms(lw, words, (w) => w.endsWith(lw));
      if (cands.length) {
        const ranked = byScore(cands);
        if (score(ranked[0]) - score(t.shown) > 3) {
          const best = ranked[0];
          const shown = atLineEnd ? `${t.shown}[${best.slice(lw.length)}?]` : `[${best.slice(0, best.length - lw.length)}?]${t.shown}`;
          rewrite.push([t, mark(shown, "guess", ranked.slice(0, 6))]);
          return;
        }
      }
    }
  });
  for (const [t, text] of rewrite.reverse()) page = page.slice(0, t.start) + text + page.slice(t.end);
  return page;
}

// Частые слова, которые получаются из видимой части дописыванием 1–3 букв
function longerForms(lw, words, fits) {
  const out = [];
  const limit = Math.min(words.list.length, 150000);
  for (let k = 0; k < limit && out.length < 15; k++) {
    const w = words.list[k];
    if (w.length > lw.length && w.length <= lw.length + 3 && fits(w)) out.push(w);
  }
  return out;
}

// ——— Сборка строк и абзацев ———

function layout(items, onRow) {
  if (!items.length) return [];
  // Общий наклон страницы — по длинным строкам; координаты переводим в «выпрямленную» систему
  const angles = items.filter((it) => it.L > it.H * 3).map((it) => it.angle).sort((a, b) => a - b);
  const skew = angles.length ? angles[angles.length >> 1] : 0;
  const cos = Math.cos(-skew), sin = Math.sin(-skew);
  for (const it of items) {
    const rx = it.cx * cos - it.cy * sin, ry = it.cx * sin + it.cy * cos;
    Object.assign(it, { rx0: rx - it.L / 2, rx1: rx + it.L / 2, ry0: ry - it.H / 2, ry1: ry + it.H / 2, rcy: ry });
  }
  items.sort((a, b) => a.rcy - b.rcy);
  const rows = [];
  for (const it of items) {
    const ih = it.ry1 - it.ry0;
    const row = rows.find((r) => r.small === !!it.small && Math.abs(r.cy - it.rcy) < Math.min(r.h, ih) * 0.5);
    if (row) {
      row.items.push(it);
      row.cy = (row.cy * (row.items.length - 1) + it.rcy) / row.items.length;
      row.y0 = Math.min(row.y0, it.ry0); row.y1 = Math.max(row.y1, it.ry1);
    } else rows.push({ cy: it.rcy, h: ih, y0: it.ry0, y1: it.ry1, items: [it], small: !!it.small });
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const row of rows) {
    row.items.sort((a, b) => a.rx0 - b.rx0);
    row.text = row.items.map((it) => it.text).join(" ");
    // Мелкий текст заглавными — надпись печати или штампа
    const letters = row.text.replace(/\P{L}/gu, "");
    row.stamp = row.small && letters.length >= 3 && (letters.match(/\p{Lu}/gu) || []).length >= letters.length * 0.7;
  }
  const body = rows.filter((r) => !r.stamp);

  const heights = body.map((r) => r.h).sort((a, b) => a - b);
  const lineH = heights[heights.length >> 1] || 0;
  // Абзац — промежуток заметно больше обычного межстрочного
  const gaps = body.slice(1).map((r, i) => r.y0 - body[i].y1).sort((a, b) => a - b);
  const paraGap = Math.max((gaps[gaps.length >> 1] ?? 0) * 1.6, lineH * 0.6);
  // Где строка на исходном фото — для сверки текста с фото
  const rowBox = (r) => [Math.min(...r.items.map((i) => i.x0)), Math.min(...r.items.map((i) => i.y0)), Math.max(...r.items.map((i) => i.x1)), Math.max(...r.items.map((i) => i.y1))];
  const unite = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const out = [], boxes = [];
  let prevRow = null, stampGroup = null;
  for (const row of rows) {
    if (row.stamp) {
      // Строки одной печати (рядом друг с другом) собираем в одну пометку
      if (stampGroup && row.cy - stampGroup.cy < lineH * 4) {
        stampGroup.parts.push(row.text); stampGroup.cy = row.cy;
        boxes[stampGroup.at] = unite(boxes[stampGroup.at], rowBox(row));
        continue;
      }
      stampGroup = { cy: row.cy, parts: [row.text], at: out.length };
      out.push(null); boxes.push(rowBox(row));
      continue;
    }
    if (onRow && !row.small) onRow(row.items);
    if (prevRow && row.y0 - prevRow.y1 > paraGap) { out.push(""); boxes.push(null); }
    out.push(row.items.map((it) => it.text).join(" "));
    boxes.push(rowBox(row));
    prevRow = row;
    if (stampGroup) out[stampGroup.at] = `[Печать: ${stampGroup.parts.join(" ")}]`;
  }
  if (stampGroup) out[stampGroup.at] = `[Печать: ${stampGroup.parts.join(" ")}]`;
  const keep = out.map((l) => l !== null);
  const lines = out.filter((_, i) => keep[i]);
  lines.boxes = boxes.filter((_, i) => keep[i]);
  return lines;
}
