// Generate all favicon / app-icon / unfurl assets from web/public/icon.svg.
//
//   node web/scripts/gen-assets.mjs
//
// Rasterises the SVG with sharp (borrowed from edge/node_modules), packs a
// multi-size favicon.ico (PNG-in-ICO, dependency-free), and renders the 1200x630
// Open Graph image via headless Chrome so the Fraunces wordmark is pixel-exact.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const pub = path.join(webDir, "public");
const sharp = createRequire(path.join(repo, "edge", "package.json"))("sharp");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CREAM = { r: 245, g: 239, b: 224, alpha: 1 }; // --bg #f5efe0
const masterPath = path.join(pub, "logo.png"); // transparent, trimmed bird
const master = readFileSync(masterPath);
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// Render the bird (contain) at `size`, optionally padded and on a solid bg.
async function bird(size, { bg = TRANSPARENT, padFrac = 0 } = {}) {
  const inner = Math.round(size * (1 - padFrac * 2));
  const markPng = await sharp(master)
    .resize(inner, inner, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: markPng, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Pack PNG buffers into a multi-resolution .ico (PNG-compressed entries).
function pngsToIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const d = dir.subarray(i * 16, i * 16 + 16);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0); // width
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1); // height
    d.writeUInt8(0, 2); // palette count
    d.writeUInt8(0, 3); // reserved
    d.writeUInt16LE(1, 4); // colour planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(e.buf.length, 8); // image byte size
    d.writeUInt32LE(offset, 12); // offset
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

function write(name, buf) {
  writeFileSync(path.join(pub, name), buf);
  console.log(`  ${name.padEnd(26)} ${(buf.length / 1024).toFixed(1)} KB`);
}

async function ogImage() {
  const tmp = mkdtempSync(path.join(tmpdir(), "og-"));
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@500&display=swap" rel="stylesheet">
<style>
  html,body{margin:0}
  .card{width:1200px;height:630px;box-sizing:border-box;position:relative;overflow:hidden;
    background:radial-gradient(120% 130% at 50% -10%, #f7f1e3 0%, #efe7d4 70%, #e7ddc6 100%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Inter,sans-serif}
  .dot{position:absolute;border-radius:50%;opacity:.5}
  .mark{width:230px;height:230px;margin-bottom:6px;filter:drop-shadow(0 10px 24px rgba(58,50,38,.18))}
  h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:140px;line-height:1;margin:8px 0 0;color:#3a3226;letter-spacing:.5px}
  .rule{width:120px;height:5px;border-radius:999px;margin:26px 0 22px;
    background:linear-gradient(90deg,#17a39a,#2185bf,#2b53a6)}
  p{font-size:30px;color:#6b5f4d;margin:0;letter-spacing:.3px}
</style></head>
<body><div class="card">
  <div class="mark"><img src="file://${masterPath}" style="width:100%;height:100%;object-fit:contain"/></div>
  <h1>Birds</h1>
  <div class="rule"></div>
  <p>birds heard at aperauch.com</p>
</div></body></html>`;
  const htmlPath = path.join(tmp, "og.html");
  const rawPng = path.join(tmp, "og-raw.png");
  writeFileSync(htmlPath, html);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1200,630", "--force-device-scale-factor=2",
    "--virtual-time-budget=5000", `--screenshot=${rawPng}`, `file://${htmlPath}`,
  ], { stdio: "ignore" });
  // Down-sample the 2x capture to a crisp, compressed 1200x630.
  const buf = await sharp(readFileSync(rawPng))
    .resize(1200, 630, { fit: "cover" })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
  write("og.png", buf);
}

async function main() {
  console.log("Generating assets into web/public/ …");
  // favicon.ico (16/32/48, transparent)
  const ico = pngsToIco(await Promise.all([16, 32, 48].map(async (s) => ({ size: s, buf: await bird(s) }))));
  write("favicon.ico", ico);
  // PWA icons (transparent) + maskable (cream, padded) + apple-touch (cream, padded)
  write("icon-192.png", await bird(192));
  write("icon-512.png", await bird(512));
  write("icon-512-maskable.png", await bird(512, { bg: CREAM, padFrac: 0.18 }));
  write("apple-touch-icon.png", await bird(180, { bg: CREAM, padFrac: 0.14 }));
  await ogImage();
  console.log("Done.");
}

await main();
