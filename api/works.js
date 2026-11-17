// API dla panelu /admin.
// GET  /api/works                → publiczna lista prac (czyta ją strona główna)
// POST /api/works  {action:...}  → wymaga nagłówka x-admin-password (zmienna ADMIN_PASSWORD na Vercelu)
//   action "check" – sprawdza hasło
//   action "load"  – świeża lista z pominięciem cache
//   action "meta"  – pobiera tytuł filmu (YouTube / Vimeo / TikTok)
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

async function meta(url) {
  let u;
  try { u = new URL(url); } catch { return {}; }
  const host = u.hostname.replace(/^(www|m)\./, "");
  let endpoint = null;
  if (host === "youtu.be" || host.endsWith("youtube.com")) {
    const parts = u.pathname.split("/").filter(Boolean);
    const target = parts[0] === "shorts" && parts[1] ? `https://www.youtube.com/watch?v=${parts[1]}` : url;
    endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;
  } else if (host.endsWith("vimeo.com")) {
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  } else if (host.endsWith("tiktok.com")) {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  }
  if (!endpoint) return {};
  try {
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    const d = await r.json();
    return { title: d.title || "", author: d.author_name || "" };
  } catch {
    return {};
  }
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
