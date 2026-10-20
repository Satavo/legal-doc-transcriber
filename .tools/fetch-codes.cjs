// Скачивает тексты кодексов РФ с Викитеки (официальные тексты законов не охраняются авторским правом, ст. 1259 ГК РФ)
// и складывает их в corpus/*.txt. Запуск: node fetch-codes.cjs
const fs = require("fs");
const API = "https://ru.wikisource.org/w/api.php";
const UA = { "User-Agent": "legal-ocr-research/1.0 (one-off corpus build)" };
const ROOTS = [
  "Гражданский кодекс РФ", "Гражданский процессуальный кодекс РФ", "Уголовный кодекс Российской Федерации",
  "Уголовно-процессуальный кодекс РФ", "Арбитражный процессуальный кодекс РФ", "Кодекс РФ об административных правонарушениях",
  "Трудовой кодекс РФ", "Семейный кодекс РФ", "Жилищный кодекс РФ", "Кодекс административного судопроизводства РФ",
  "Уголовно-исполнительный кодекс РФ", "Земельный кодекс РФ",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const url = API + "?" + new URLSearchParams({ format: "json", ...params });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return r.json();
      console.log("  HTTP", r.status, "— жду");
    } catch (e) { console.log("  ошибка сети — жду"); }
    await sleep(3000 * 2 ** i);
  }
  return null;   // страницу пропускаем
}
async function subpages(root) {
  const out = [root];
  let cont = {};
  do {
    const j = await api({ action: "query", list: "allpages", apprefix: root + "/", apnamespace: 0, aplimit: 500, ...cont });
    out.push(...j.query.allpages.map((p) => p.title));
    cont = j.continue || null;
  } while (cont);
  return out;
}
const clean = (wt) => wt
  .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/\{\{[^{}]*\}\}/g, " ").replace(/\{\{[^{}]*\}\}/g, " ")
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").replace(/^[=*#:;|!{}].*$/gm, (l) => l.replace(/^[=*#:;|!{}\s]+|[=\s]+$/g, ""));
(async () => {
  fs.mkdirSync("corpus", { recursive: true });
  let total = 0;
  for (const root of ROOTS) {
    const file = `corpus/${root.replace(/[^\p{L}\d]+/gu, "_")}.txt`;
    if (fs.existsSync(file)) { total += fs.statSync(file).size; console.log(root, "уже есть"); continue; }
    const pages = await subpages(root);
    let text = "";
    for (const title of pages) {
      const j = await api({ action: "parse", page: title, prop: "wikitext", redirects: 1 });
      if (j?.parse) text += clean(j.parse.wikitext["*"]) + "\n";
      await sleep(600);
    }
    fs.writeFileSync(file, text);
    total += text.length;
    console.log(root, pages.length, "pages", Math.round(text.length / 1024), "KB");
  }
  console.log("total", Math.round(total / 1024 / 1024), "MB");
})();
