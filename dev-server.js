// Локальный запуск без Vercel CLI: node dev-server.js → http://localhost:3000
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const PORT = process.env.PORT || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
};

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    // Серверные функции из api/*.js — как на Vercel
    const api = path.match(/^\/api\/([\w-]+)$/);
    if (api) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { req.body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { req.body = {}; }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      try {
        const { default: handler } = await import(`./api/${api[1]}.js`);
        return handler(req, res);
      } catch {
        res.statusCode = 404;
        return res.end("Not found");
      }
    }
    // Те же заголовки, что в vercel.json: нужны для многопоточного WebAssembly
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const file = normalize(path === "/" ? "/index.html" : path).replace(/^[\\/]+/, "");
    if (file.startsWith("..")) { res.statusCode = 400; return res.end(); }
    try {
      const body = await readFile(new URL(`./public/${file}`, import.meta.url));
      res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
