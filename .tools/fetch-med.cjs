// Медицинские тексты для словаря и контекста:
//  • законы о здравоохранении, психиатрической помощи и судебной экспертизе с Викитеки → corpus/*.txt
//    (официальные тексты законов не охраняются авторским правом, ст. 1259 ГК РФ);
//  • медицинские статьи русской Википедии (CC BY-SA) → corpus-wiki/*.txt — из них берутся только слова и пары слов.
// Запуск: node fetch-med.cjs
const fs = require("fs");
const UA = { "User-Agent": "legal-doc-transcriber/1.0 (https://github.com/satavo/legal-doc-transcriber; one-off corpus build)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAWS = [
  "Федеральный закон от 21.11.2011 № 323-ФЗ",   // об основах охраны здоровья граждан
  "Закон РФ от 02.07.1992 № 3185-1",              // о психиатрической помощи
  "Федеральный закон от 31.05.2001 № 73-ФЗ",     // о государственной судебно-экспертной деятельности
  "Федеральный закон от 29.11.2010 № 326-ФЗ",    // об обязательном медицинском страховании
  "Федеральный закон от 12.04.2010 № 61-ФЗ",     // об обращении лекарственных средств
  "Федеральный закон от 24.07.1998 № 125-ФЗ",    // о страховании от несчастных случаев на производстве
];
const CATEGORIES = [
  "Психиатрия", "Психические расстройства", "Расстройства личности", "Симптомы психических расстройств", "Судебная медицина",
  "Судебная психиатрия", "Неврология", "Заболевания нервной системы", "Кардиология", "Сердечно-сосудистые заболевания",
  "Травматология", "Травмы", "Хирургия", "Хирургические операции", "Онкология", "Злокачественные новообразования",
  "Инфекционные заболевания", "Эндокринология", "Гастроэнтерология", "Пульмонология", "Нефрология", "Офтальмология",
  "Оториноларингология", "Педиатрия", "Акушерство", "Гинекология", "Урология", "Дерматология", "Стоматология",
  "Анестезиология", "Реаниматология", "Медицинская диагностика", "Лабораторная диагностика", "Симптомы",
  "Синдромы", "Анатомия человека", "Физиология человека", "Фармакология", "Лекарственные средства", "Антибиотики",
  "Анальгетики", "Психофармакология", "Антидепрессанты", "Нейролептики", "Транквилизаторы", "Наркология",
  "Клиническая психология", "Медицинская психология", "Реабилитация", "Медицинская терминология", "Здравоохранение в России",
  "Классы МКБ-10",
];
const MAX_WIKI_PAGES = 3000;

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: "json", formatversion: 2, ...params });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) { await sleep(1000); return r.json(); }   // не чаще раза в секунду
      console.log("  HTTP", r.status, "— жду");
    } catch { console.log("  ошибка сети — жду"); }
    await sleep(3000 * 2 ** i);
  }
  return null;
}
const clean = (wt) => wt
  .replace(/<ref[^>]*\/>/g, " ").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/\{\{[^{}]*\}\}/g, " ").replace(/\{\{[^{}]*\}\}/g, " ").replace(/\{\{[^{}]*\}\}/g, " ")
  .replace(/\[\[(?:Файл|File|Изображение|Категория|Category):[^\]]*\]\]/g, " ")
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\[https?:[^\s\]]+ ?([^\]]*)\]/g, "$1")
  .replace(/'{2,}/g, "").replace(/^[=*#:;|!{}].*$/gm, (l) => l.replace(/^[=*#:;|!{}\s]+|[=\s]+$/g, ""));

async function allPages(host, prefix) {
  const out = [prefix];
  let cont = {};
  do {
    const j = await api(host, { action: "query", list: "allpages", apprefix: prefix + "/", apnamespace: 0, aplimit: 500, ...cont });
    if (!j) break;
    out.push(...j.query.allpages.map((p) => p.title));
    cont = j.continue || null;
  } while (cont);
  return out;
}
// Тексты страниц пачками по 50 (wikitext)
async function contents(host, titles) {
  let text = "";
  for (let i = 0; i < titles.length; i += 50) {
    const j = await api(host, { action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: titles.slice(i, i + 50).join("|"), redirects: 1 });
    for (const p of j?.query?.pages || []) {
      const wt = p.revisions?.[0]?.slots?.main?.content;
      if (wt) text += clean(wt) + "\n";
    }
    await sleep(400);
  }
  return text;
}
async function categoryPages(cat, depth, seen, pages) {
  if (seen.has(cat) || pages.size >= MAX_WIKI_PAGES) return;
  seen.add(cat);
  let cont = {};
  const subcats = [];
  do {
    const j = await api("ru.wikipedia.org", { action: "query", list: "categorymembers", cmtitle: "Категория:" + cat, cmlimit: 500, cmtype: "page|subcat", ...cont });
    if (!j) break;
    for (const m of j.query.categorymembers) {
      if (m.ns === 14) subcats.push(m.title.replace(/^Категория:/, ""));
      else if (m.ns === 0) pages.add(m.title);
    }
    cont = j.continue || null;
  } while (cont && pages.size < MAX_WIKI_PAGES);
  if (depth > 0) for (const s of subcats) await categoryPages(s, depth - 1, seen, pages);
}

(async () => {
  fs.mkdirSync("corpus", { recursive: true });
  fs.mkdirSync("corpus-wiki", { recursive: true });
  for (const law of LAWS) {
    const file = `corpus/${law.replace(/[^\p{L}\d]+/gu, "_")}.txt`;
    if (fs.existsSync(file)) { console.log(law, "уже есть"); continue; }
    const titles = await allPages("ru.wikisource.org", law);
    const text = await contents("ru.wikisource.org", titles);
    fs.writeFileSync(file, text);
    console.log(law, titles.length, "стр.", Math.round(text.length / 1024), "КБ");
  }
  const wikiFile = "corpus-wiki/medicine.txt";
  if (!fs.existsSync(wikiFile)) {
    const pages = new Set(), seen = new Set();
    for (const c of CATEGORIES) {
      await categoryPages(c, 1, seen, pages);
      console.log("категория", c, "→ всего статей", pages.size);
      if (pages.size >= MAX_WIKI_PAGES) break;
    }
    const text = await contents("ru.wikipedia.org", [...pages]);
    fs.writeFileSync(wikiFile, text);
    console.log("Википедия:", pages.size, "статей", Math.round(text.length / 1024 / 1024), "МБ");
  }
})();
