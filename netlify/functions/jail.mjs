import { getStore } from "@netlify/blobs";

// Prison : l'un met l'autre au cachot, l'autre ne peut plus rien faire (réponses, boutique…).
// Il est libéré par celui qui l'a mis, ou automatiquement au bout d'une heure.
// GET  /api/jail                           -> { bilge: null | {by, at, until}, lele: ..., now }
// POST /api/jail {action:"jail"|"free", by, who}

const WHO = ["bilge", "lele"];
const HOUR = 60 * 60 * 1000;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const prison = () => getStore({ name: "prison-v1", consistency: "strong" });

// Renvoie la fiche de détention en cours (ou null) ; efface celle qui a expiré.
export async function jailRecord(who) {
  if (!WHO.includes(who)) return null;
  const st = prison();
  let rec = null;
  try { rec = JSON.parse((await st.get(who)) || "null"); } catch { rec = null; }
  if (!rec) return null;
  if (!(rec.until > Date.now())) { await st.delete(who); return null; }
  return rec;
}

export default async (req) => {
  if (req.method === "GET") {
    const out = { now: Date.now() };
    for (const w of WHO) out[w] = await jailRecord(w);
    return json(out);
  }
  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") || 0) > 500) return json({ error: "trop gros" }, 413);
    let b;
    try { b = await req.json(); } catch { return json({ error: "json invalide" }, 400); }
    if (!WHO.includes(b.by) || !WHO.includes(b.who) || b.by === b.who) return json({ error: "demande invalide" }, 400);
    if (b.action === "jail") {
      if (await jailRecord(b.by)) return json({ error: "Tu es en prison, tu ne peux rien faire" }, 423);
      if (await jailRecord(b.who)) return json({ error: "Déjà en prison" }, 409);
      const at = Date.now();
      await prison().set(b.who, JSON.stringify({ by: b.by, at, until: at + HOUR }));
      return json({ ok: true });
    }
    if (b.action === "free") {
      const rec = await jailRecord(b.who);
      if (!rec) return json({ ok: true });
      if (rec.by !== b.by) return json({ error: "Seul celui qui l'a mis en prison peut le libérer" }, 403);
      await prison().delete(b.who);
      return json({ ok: true });
    }
    return json({ error: "action inconnue" }, 400);
  }
  return json({ error: "méthode non autorisée" }, 405);
};

export const config = { path: "/api/jail" };
