import path from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
// Localhost only by default. Set HOST=0.0.0.0 to open it to your network (use HTTPS for that; see README).
const host = process.env.HOST || "127.0.0.1";
const dataDir = path.resolve(process.env.DATA_DIR || "data");

const app = createApp({ dataDir, secureCookies: process.env.COOKIE_SECURE === "1" });
// Behind a reverse proxy (nginx, Caddy) that terminates HTTPS, trust it for the client IP and protocol.
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.listen(port, host, () => {
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log(`Sparepart ERP running at ${url}  (data: ${dataDir})`);
  if (app.locals.needsSetup()) {
    console.log(`\n  First run: open ${url} and create the admin account.`);
    console.log(`  Setup code: ${app.locals.setupCode}\n`);
  }
});
