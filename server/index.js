import path from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
// Localhost only by default: there is no login yet. Set HOST=0.0.0.0 to open it to your network.
const host = process.env.HOST || "127.0.0.1";
const dataDir = path.resolve(process.env.DATA_DIR || "data");

const app = createApp({ dataDir });
app.listen(port, host, () => {
  console.log(`Sparepart ERP running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (data: ${dataDir})`);
});
