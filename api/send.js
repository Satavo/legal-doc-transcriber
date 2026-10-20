// Отправка расшифровки на email через Gmail (SMTP).
// Переменные окружения Vercel:
//   GMAIL_USER          — адрес Gmail, с которого уходят письма
//   GMAIL_APP_PASSWORD  — пароль приложения Google (myaccount.google.com/apppasswords)
//   SEND_PASSWORD       — пароль для отправки с сайта, чтобы посторонние не рассылали письма с вашей почты
import nodemailer from "nodemailer";

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const MAX_RECIPIENTS = 5;

export default async function handler(req, res) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, SEND_PASSWORD } = process.env;
  const configured = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD && SEND_PASSWORD);

  // Страница спрашивает, настроена ли отправка
  if (req.method === "GET") return res.status(200).json({ configured });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured) return res.status(503).json({ error: "Отправка не настроена: задайте GMAIL_USER, GMAIL_APP_PASSWORD и SEND_PASSWORD в настройках Vercel" });

  const { to, subject, text, files, password, check } = req.body || {};
  if (password !== SEND_PASSWORD) return res.status(401).json({ error: "Неверный пароль отправки", needPassword: true });
  // Страница проверяет пароль сразу после ввода, ничего не отправляя
  if (check) return res.status(200).json({ ok: true });

  const recipients = String(to || "").split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length || recipients.length > MAX_RECIPIENTS || !recipients.every((r) => EMAIL_RE.test(r))) {
    return res.status(400).json({ error: `Укажите от 1 до ${MAX_RECIPIENTS} корректных адресов` });
  }
  const list = Array.isArray(files) ? files.slice(0, 3) : [];
  if (!text && !list.length) return res.status(400).json({ error: "Нечего отправлять" });

  // Вложения .docx: { name, data (base64) } — например, «с пометками» и «чистовик»
  const attachments = list.filter((f) => f?.data).map((f) => ({
    filename: String(f.name || "rasshifrovka.docx").replace(/[\\/:*?"<>|]/g, "_"),
    content: Buffer.from(f.data, "base64"),
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));

  try {
    const transport = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
    await transport.sendMail({
      from: GMAIL_USER,
      to: recipients.join(", "),
      subject: String(subject || "Расшифровка документа").slice(0, 200),
      text: String(text || "Расшифровка документа во вложении."),
      attachments,
    });
    return res.status(200).json({ ok: true, sent: recipients.length });
  } catch (err) {
    console.error(err);
    const auth = /Invalid login|Username and Password not accepted|EAUTH/i.test(String(err?.message) + err?.code);
    return res.status(502).json({ error: auth ? "Gmail не принял логин: проверьте GMAIL_USER и пароль приложения" : "Не удалось отправить письмо: " + (err?.message || err) });
  }
}
