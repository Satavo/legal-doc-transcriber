// Строит статистику контекста из corpus/*.txt → ../public/models/ctx.txt
// Строки файла:
//   «w слово1 слово2 N» — пара слов встретилась N раз
//   «e конец1 конец2 N» — пара «окончаний» (последние 3 буквы, а у служебных слов — слово целиком, с «=»)
const fs = require("fs");
const FUNC = new Set("в во на по за до от из у с со к ко о об обо при для без под над про через между перед после и а но или либо не ни что как чтобы если когда же ли бы то это его ее их ему ей им который которая которое которые которого которой которых".split(" "));
const norm = (w) => w.toLowerCase().replace(/ё/g, "е");
const end = (w) => (FUNC.has(w) ? "=" + w : w.length <= 3 ? "=" + w : w.slice(-3));

const wb = new Map(), eb = new Map();
let tokens = 0;
for (const f of fs.readdirSync("corpus")) {
  const text = fs.readFileSync("corpus/" + f, "utf8");
  // Пары считаем только внутри куска без знаков препинания
  for (const chunk of text.split(/[.,;:!?()«»"\n\[\]{}|=*—–]+/)) {
    const ws = (chunk.match(/[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/g) || []).map(norm);
    tokens += ws.length;
    for (let i = 1; i < ws.length; i++) {
      const k = ws[i - 1] + " " + ws[i];
      wb.set(k, (wb.get(k) || 0) + 1);
      const e = end(ws[i - 1]) + " " + end(ws[i]);
      eb.set(e, (eb.get(e) || 0) + 1);
    }
  }
}
const MIN_W = +(process.argv[2] || 3), MIN_E = 2;
const lines = [];
for (const [k, n] of eb) if (n >= MIN_E) lines.push("e " + k + " " + n);
const wl = [...wb].filter(([, n]) => n >= MIN_W);
for (const [k, n] of wl) lines.push("w " + k + " " + n);
fs.writeFileSync("../public/models/ctx.txt", lines.join("\n") + "\n");
console.log({ tokens, wordPairs: wb.size, keptWordPairs: wl.length, endPairs: eb.size, bytes: fs.statSync("../public/models/ctx.txt").size });
