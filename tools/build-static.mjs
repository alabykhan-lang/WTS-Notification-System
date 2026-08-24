import { cp, mkdir, rm } from "node:fs/promises";

const staticFiles = [
  "api.js",
  "app.js",
  "bulk.js",
  "config.js",
  "identity-login.js",
  "index.html",
  "manifest.webmanifest",
  "public-live.js",
  "styles.css",
  "whatsapp.html",
  "whatsapp.js",
];

await rm("public", { recursive: true, force: true });
await mkdir("public", { recursive: true });

for (const file of staticFiles) {
  await cp(file, `public/${file}`);
}
