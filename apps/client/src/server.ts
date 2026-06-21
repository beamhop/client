import { serve } from "bun";
import index from "./index.html";
import { MANIFEST_JSON } from "./pwa/manifest.ts";

const port = Number(process.env.PORT ?? 3000);

const server = serve({
  port,
  routes: {
    "/manifest.webmanifest": new Response(MANIFEST_JSON, {
      headers: { "content-type": "application/manifest+json" },
    }),
    "/icons/:file": (req: Bun.BunRequest<"/icons/:file">): Response =>
      new Response(Bun.file(`public/icons/${req.params.file}`)),
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Beamhop client running at ${server.url}`);
