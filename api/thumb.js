// Serwuje miniatury zapisane przez panel w prywatnym magazynie Blob.
// /api/thumb?f=<nazwa>  → obrazek, mocno cache'owany na CDN Vercela
import { get } from "@vercel/blob";

export default async function handler(req, res) {
  const f = String(req.query?.f || "");
  if (!/^[a-z0-9-]{6,64}$/.test(f)) return res.status(400).end();
  try {
    const r = await get(`portfolio/thumbs/${f}.jpg`, { access: "private" });
    if (!r || r.statusCode !== 200 || !r.stream) return res.status(404).end();
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    res.setHeader("Content-Type", r.blob.contentType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).end(buf);
  } catch (e) {
    console.error(e);
    return res.status(500).end();
  }
}
