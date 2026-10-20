// Набор тестовых страниц и подсчёт ошибок распознавания (запускается в браузере на странице сайта)
window.bench = async function (recognizeFn) {
  const PAGES = [
    { rot: 0, blur: 0, noise: 0, font: "26px Times New Roman", lines: [
      "ДОГОВОР КУПЛИ-ПРОДАЖИ НЕДВИЖИМОГО ИМУЩЕСТВА № 7/2026",
      "г. Казань «03» марта 2026 г.",
      "Гражданин Российской Федерации Кузнецов Дмитрий Олегович, именуемый",
      "в дальнейшем «Продавец», с одной стороны, и гражданка Российской",
      "Федерации Белова Ирина Викторовна, именуемая в дальнейшем «Покупатель»,",
      "с другой стороны, заключили настоящий договор о нижеследующем:",
      "1.1. Продавец обязуется передать в собственность Покупателя квартиру,",
      "общей площадью 47,3 кв. м, кадастровый номер 16:50:011104:2876.",
    ]},
    { rot: -0.035, blur: 1, noise: 30, font: "28px Georgia", lines: [
      "4. ОТВЕТСТВЕННОСТЬ СТОРОН",
      "4.1. В случае неисполнения или ненадлежащего исполнения обязательств",
      "по настоящему договору стороны несут ответственность в соответствии",
      "с действующим законодательством Российской Федерации.",
      "4.2. Покупатель уплачивает неустойку в размере 0,5 % от суммы долга",
      "за каждый день просрочки, но не более 10 % от общей суммы договора.",
    ]},
    { rot: 0.02, blur: 0.6, noise: 18, font: "22px Arial", lines: [
      "ДОВЕРЕННОСТЬ",
      "Я, Смирнова Елена Александровна, 12.04.1985 года рождения, паспорт",
      "серии 92 15 номер 483920, выдан Отделом УФМС России по Республике",
      "Татарстан в Вахитовском районе гор. Казани 20.05.2015 года, код",
      "подразделения 160-004, настоящей доверенностью уполномочиваю",
      "представлять мои интересы во всех судебных учреждениях.",
    ]},
    { rot: -0.012, blur: 1.4, noise: 40, font: "24px Times New Roman", lines: [
      "Решение принято единогласно всеми участниками общего собрания.",
      "Председатель собрания подписал протокол в присутствии секретаря.",
      "Копии протокола направлены участникам в течение трёх рабочих дней.",
      "Государственная регистрация изменений осуществляется в порядке,",
      "установленном Федеральным законом от 08.08.2001 № 129-ФЗ.",
    ]},
  ];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const lev = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const clean = (s) => s.replace(/[^]*/g, "") /*BOXSTRIP*/.replace(/[-][^]*?[^]*/g, (m) => m.slice(1, m.indexOf(""))).replace(/\s+/g, " ").trim();
  let errs = 0, total = 0;
  const details = [];
  for (const p of PAGES) {
    const c = document.createElement("canvas"); c.width = 1300; c.height = 120 + p.lines.length * 52;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, c.width, c.height); g.addColorStop(0, "#f6f3ea"); g.addColorStop(1, p.noise ? "#b5b1a6" : "#f6f3ea");
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    x.save(); x.translate(c.width / 2, c.height / 2); x.rotate(p.rot); x.translate(-c.width / 2, -c.height / 2);
    if (p.blur) x.filter = `blur(${p.blur}px)`;
    x.fillStyle = "#23232b"; x.font = p.font;
    p.lines.forEach((t, i) => x.fillText(t, 70, 80 + i * 52));
    x.restore();
    if (p.noise) {
      const id = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < id.data.length; i += 4) { const n = (rand() - 0.5) * p.noise; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
      x.putImageData(id, 0, 0);
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    const out = clean(await recognizeFn(new File([blob], "b.jpg", { type: "image/jpeg" })));
    const truth = p.lines.join(" ");
    const e = lev(out, truth);
    errs += e; total += truth.length;
    details.push({ errors: e, out });
  }
  return { cer: +(100 * errs / total).toFixed(2), errs, total, details };
};
