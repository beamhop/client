/// <reference lib="dom" />
/**
 * Rasterize the brand SVG sources in public/icons/ into the PNG variants that
 * iOS Add-to-Home-Screen, the PWA manifest, and <link rel="icon"> fallbacks
 * need. Uses headless Chrome over CDP (same plumbing as capture-all.ts) so no
 * image-processing dependency is required. Run after editing any icon SVG:
 *
 *   bun scripts/gen-icons.ts
 */
import { spawn } from "bun";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9252;
const ICONS = "public/icons";

/** SVG source → PNG output(s). The SVG carries its own (opaque) background. */
const TARGETS: readonly { svg: string; out: string; size: number }[] = [
  { svg: "favicon.svg", out: "favicon-32.png", size: 32 },
  { svg: "apple-touch-icon.svg", out: "apple-touch-icon-180.png", size: 180 },
  { svg: "icon.svg", out: "icon-192.png", size: 192 },
  { svg: "icon.svg", out: "icon-512.png", size: 512 },
  { svg: "icon-maskable.svg", out: "icon-512-maskable.png", size: 512 },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const chrome = spawn([
  CHROME, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/beamhop-icons/profile",
  "--force-device-scale-factor=1", "about:blank",
]);

const wsUrl = await (async (): Promise<string> => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl: string };
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error("Chrome CDP never came up");
})();

const ws = new WebSocket(wsUrl);
await new Promise<void>((res) => (ws.onopen = () => res()));
let seq = 0;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
let sessionId: string | undefined;
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown> };
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)?.(msg.result ?? {});
    pending.delete(msg.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}, useSession = true): Promise<Record<string, unknown>> => {
  const id = ++seq;
  const payload: Record<string, unknown> = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res) => pending.set(id, res));
};

const targets = (await send("Target.getTargets", {}, false)) as { targetInfos: { targetId: string; type: string }[] };
const page = targets.targetInfos.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const attach = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false)) as { sessionId: string };
sessionId = attach.sessionId;
await send("Page.enable");

for (const { svg, out, size } of TARGETS) {
  const svgMarkup = await Bun.file(`${ICONS}/${svg}`).text();
  // Stretch the SVG to fill an exact size×size viewport; transparent default
  // background preserves rounded-corner transparency on favicon.svg.
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}svg{display:block;width:100vw;height:100vh}</style>${svgMarkup}`;
  await send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
  await sleep(250);
  const shot = (await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    captureBeyondViewport: true,
  })) as { data: string };
  await Bun.write(`${ICONS}/${out}`, Buffer.from(shot.data, "base64"));
  console.log(`  ${out} (${size}×${size}) <- ${svg}`);
}

ws.close();
chrome.kill();
console.log(`Generated ${TARGETS.length} icons into ${ICONS}/`);
