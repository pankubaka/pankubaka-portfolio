// API dla panelu /admin.
// GET  /api/works                → publiczna lista prac (czyta ją strona główna)
// POST /api/works  {action:...}  → wymaga nagłówka x-admin-password (zmienna ADMIN_PASSWORD na Vercelu)
//   action "check" – sprawdza hasło
//   action "load"  – świeża lista z pominięciem cache
//   action "meta"  – pobiera tytuł i miniaturę (YouTube / Instagram / TikTok / Vimeo)
//   action "save"  – zapisuje listę {works:[...]}
import { put, get } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const FILE = "portfolio/works.json";
const CATS = ["rolki", "filmy", "wywiady", "eventy"];

// Magazyn Blob jest prywatny i łączy się przez OIDC (BLOB_STORE_ID) – biblioteka sama się loguje.
// Starsze magazyny z kluczem BLOB_READ_WRITE_TOKEN też działają.
const hasBlob = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

function authorized(req) {
  const pass = process.env.ADMIN_PASSWORD;
  const given = req.headers["x-admin-password"];
  if (!pass || typeof given !== "string" || !given) return false;
  const a = createHash("sha256").update(pass).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function clean(items) {
  if (!Array.isArray(items)) return null;
  return items
    .slice(0, 300)
    .map((i) => ({
      url: str(i?.url, 500),
      tytul: str(i?.tytul, 200),
      klient: str(i?.klient, 100),
      kategoria: CATS.includes(i?.kategoria) ? i.kategoria : "filmy",
      okladka: str(i?.okladka, 500),
    }))
    .filter((i) => /^https:\/\//i.test(i.url));
}

async function readWorks() {
  const r = await get(FILE, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return [];
  const d = await new Response(r.stream).json();
  return Array.isArray(d) ? d : [];
}

// ---------- automatyczne tytuły i miniatury ----------
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const UA_BOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

async function fetchText(url, ua) {
  try {
    const r = await fetch(url, { headers: { "user-agent": ua, "accept-language": "en-US,en;q=0.9,pl;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.text() : "";
  } catch { return ""; }
}
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA_BROWSER }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}
const decode = (s) => String(s || "")
  .replace(/\\u0026/g, "&").replace(/\\\//g, "/")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const pick = (html, re) => { const m = html.match(re); return m ? decode(m[1]) : ""; };
function og(html, prop) {
  return pick(html, new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)`, "i"))
      || pick(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
}
// Z opisu robi krótki tytuł: pierwsza linijka, bez hashtagów, max ~90 znaków.
function tidy(text) {
  let t = decode(text).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = t.split("\n").map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim()).find(Boolean) || "";
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, "") + "…";
  return t;
}

async function instagram(u) {
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => ["reel", "reels", "p", "tv"].includes(p));
  const code = i > -1 ? parts[i + 1] : null;
  if (!code) return {};
  const kind = parts[i] === "p" ? "p" : "reel";
  let image = "", title = "";

  // 1) strona osadzenia (embed) – zwykle zawiera obrazek i opis
  const embed = await fetchText(`https://www.instagram.com/${kind}/${code}/embed/captioned/`, UA_BROWSER);
  if (embed) {
    image = pick(embed, /class="EmbeddedMediaImage"[^>]*?src="([^"]+)"/)
         || pick(embed, /"display_url"\s*:\s*"([^"]+)"/)
         || pick(embed, /"thumbnail_src"\s*:\s*"([^"]+)"/);
    const cap = pick(embed, /class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/);
    if (cap) title = tidy(cap.replace(/<a[^>]*CaptionUsername[^>]*>[\s\S]*?<\/a>/, ""));
  }
  // 2) zapas: tagi og: z normalnej strony (tak jak widzi to podgląd linku na Facebooku)
  if (!image || !title) {
    const page = await fetchText(`https://www.instagram.com/${kind}/${code}/`, UA_BOT);
    if (page) {
      image ||= og(page, "og:image");
      if (!title) {
        const raw = og(page, "og:title") || og(page, "og:description");
        const q = raw.match(/:\s*["“]([\s\S]+)["”]\s*\.?$/);
        title = tidy(q ? q[1] : "");
      }
    }
  }
  return { title, image };
}

async function storeThumb(imageUrl, videoUrl) {
  if (!imageUrl) return "";
  try {
    const r = await fetch(imageUrl, { headers: { "user-agent": UA_BROWSER }, signal: AbortSignal.timeout(10000) });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) return "";
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8_000_000) return "";
    const name = createHash("sha1").update(videoUrl).digest("hex").slice(0, 12) + "-" + Date.now().toString(36);
    await put(`portfolio/thumbs/${name}.jpg`, buf, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: type });
    return `/api/thumb?f=${name}`;
  } catch (e) {
    console.error("thumb", e);
    return "";
  }
}

async function meta(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }
  const host = u.hostname.replace(/^(www|m)\./, "");

  // YouTube: tytuł z oEmbed, miniatura bierze się sama z i.ytimg.com (stała, nie trzeba kopiować)
  if (host === "youtu.be" || host.endsWith("youtube.com")) {
    const parts = u.pathname.split("/").filter(Boolean);
    const target = parts[0] === "shorts" && parts[1] ? `https://www.youtube.com/watch?v=${parts[1]}` : url;
    const d = await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`);
    return { title: decode(d.title || ""), thumb: "" };
  }

  let title = "", image = "";
  if (host.endsWith("vimeo.com")) {
    const d = await fetchJson(`https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(url)}`);
    title = decode(d.title || ""); image = d.thumbnail_url || "";
  } else if (host.endsWith("tiktok.com")) {
    const d = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    title = tidy(d.title || ""); image = d.thumbnail_url || "";
  } else if (host === "instagram.com") {
    ({ title, image } = await instagram(u));
  } else {
    return {};
  }

  const thumb = await storeThumb(image, url);
  const note = thumb ? "" : image ? "nie udało się zapisać miniatury" : "platforma nie oddała miniatury, wklej własną";
  return { title, thumb, note };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const works = await readWorks();
      res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
      return res.status(200).json(works);
    }

    if (req.method === "POST") {
      if (!process.env.ADMIN_PASSWORD) {
        return res.status(500).json({ error: "Brak zmiennej ADMIN_PASSWORD w ustawieniach projektu na Vercelu." });
      }
      if (!authorized(req)) return res.status(401).json({ error: "Złe hasło." });

      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      switch (body.action) {
        case "check":
          return res.status(200).json({ ok: true });
        case "load":
          return res.status(200).json({ works: await readWorks() });
        case "meta":
          return res.status(200).json(await meta(str(body.url, 500)));
        case "save": {
          const works = clean(body.works);
          if (!works) return res.status(400).json({ error: "Niepoprawna lista prac." });
          await put(FILE, JSON.stringify(works), {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json",
          });
          return res.status(200).json({ ok: true, count: works.length });
        }
        default:
          return res.status(400).json({ error: "Nieznana akcja." });
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Metoda niedozwolona." });
  } catch (e) {
    console.error(e);
    if (!hasBlob()) {
      return res.status(500).json({
        error: "Funkcja nie widzi klucza do Vercel Blob. Podłącz magazyn Blob do projektu (Storage → Connect Store, zaznacz Production) i zrób Redeploy.",
      });
    }
    return res.status(500).json({ error: `Błąd Vercel Blob: ${String(e?.message || e).slice(0, 300)}` });
  }
}
