import { getStore } from "@netlify/blobs";

// Carnet partagé du Baromètre du bonheur.
// GET  /api/days?month=2026-10          -> { days: { "2026-10-28": [humeurBilge, humeurLele], ... } }
// POST /api/days {day, who, value}      -> enregistre l'humeur (1 à 5) d'une personne pour un jour (une seule fois : 409 si déjà validée)
// Chaque réponse est une entrée séparée ("2026-10-28/bilge") : si Bilge et Lélé
// répondent en même temps, aucune des deux réponses n'écrase l'autre.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const WHO = ["bilge", "lele"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "humeurs5", consistency: "strong" });

  if (req.method === "GET") {
    // Cagnotte : 1 pièce par personne et par jour où une humeur a été donnée.
    if (new URL(req.url).searchParams.get("coins")) {
      const { blobs } = await store.list();
      const out = { bilge: 0, lele: 0, keys: {} };
      for (const { key } of blobs) {
        const [day, who] = key.split("/");
        if (!DAY.test(day) || !WHO.includes(who)) continue;
        out[who]++; out.keys[key] = 1;
      }
      return json(out);
    }
    const month = new URL(req.url).searchParams.get("month") || "";
    if (!MONTH.test(month)) return json({ error: "mois invalide" }, 400);
    const { blobs } = await store.list({ prefix: month });
    const days = {};
    await Promise.all(
      blobs.map(async ({ key }) => {
        const [day, who] = key.split("/");
        const idx = WHO.indexOf(who);
        if (!DAY.test(day) || idx < 0) return;
        const v = Number(await store.get(key));
        if (!(v >= 1 && v <= 5)) return;
        (days[day] ||= [0, 0])[idx] = v;
      })
    );
    return json({ days });
  }

  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") || 0) > 1000) return json({ error: "trop gros" }, 413);
    let body;
    try { body = await req.json(); } catch { return json({ error: "json invalide" }, 400); }
    const { day, who, value } = body || {};
    if (!DAY.test(day || "") || !WHO.includes(who) || !Number.isInteger(value) || value < 1 || value > 5) {
      return json({ error: "données invalides" }, 400);
    }
    const d = new Date(day + "T00:00:00Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return json({ error: "date invalide" }, 400);
    if (d.getUTCFullYear() < 2020 || d.getTime() > Date.now() + 2 * 86400000) return json({ error: "date hors limites" }, 400);
    // Une réponse validée ne peut plus être changée.
    const key = `${day}/${who}`;
    const existing = await store.get(key);
    if (existing !== null && existing !== undefined) return json({ error: "déjà validé", value: Number(existing) }, 409);
    await store.set(key, String(value));
    return json({ ok: true });
  }

  return json({ error: "méthode non autorisée" }, 405);
};

export const config = { path: "/api/days" };
