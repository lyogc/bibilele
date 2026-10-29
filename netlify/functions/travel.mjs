import { getStore } from "@netlify/blobs";
import { jailRecord } from "./jail.mjs";

// Voyages : on vote en secret pour une destination, 1 vote par personne et par jour (modifiable le jour même).
// Dès que THRESH votes ont été donnés, la ville qui en a le plus l'emporte (égalité : tirage au sort).
// Le voyage commence le lendemain et dure 2 jours ; ensuite les votes repartent à zéro.
// GET  /api/travel?who=bilge          -> { today, thresh, count, trip, trips, mine, voted }
// POST /api/travel {who, city}        -> vote du jour
// Les résultats par ville ne sont jamais renvoyés avant le départ (vote secret).

const WHO = ["bilge", "lele"];
export const CITIES = ["paris", "rome", "newyork", "istanbul"];
const THRESH = 10;
const TRIP_DAYS = 2;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const zurichToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
const addDays = (key, n) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function load() {
  const st = getStore({ name: "voyage-v1", consistency: "strong" });
  let meta = { since: "2000-01-01", trips: [] };
  try { meta = JSON.parse((await st.get("meta")) || "null") || meta; } catch { /* départ propre */ }
  const { blobs } = await st.list({ prefix: "v/" });
  const votes = [];
  await Promise.all(blobs.map(async ({ key }) => {
    const [, day, who] = key.split("/");
    const city = await st.get(key);
    if (DAY.test(day) && WHO.includes(who) && CITIES.includes(city)) votes.push({ day, who, city });
  }));
  return { st, meta, votes };
}

// Calcule l'état du jour ; démarre un voyage si le seuil est atteint ; remet les votes à zéro après un retour.
async function settle(ctx) {
  const today = zurichToday(), { st, meta } = ctx;
  const last = meta.trips[meta.trips.length - 1];
  let changed = false;
  if (last && last.end < today && meta.since <= last.end) { meta.since = addDays(last.end, 1); changed = true; }
  const active = last && last.end >= today ? last : null;
  const live = ctx.votes.filter((v) => v.day >= meta.since);
  if (!active && live.length >= THRESH) {
    const tally = {};
    for (const v of live) tally[v.city] = (tally[v.city] || 0) + 1;
    const best = Math.max(...Object.values(tally));
    const top = Object.keys(tally).filter((c) => tally[c] === best);
    const city = top[Math.floor(Math.random() * top.length)];
    const start = addDays(today, 1);
    const trip = { city, start, end: addDays(start, TRIP_DAYS - 1), drawn: top.length > 1, tally };
    meta.trips.push(trip); changed = true;
  }
  if (changed) await st.set("meta", JSON.stringify(meta));
  const cur = meta.trips[meta.trips.length - 1];
  const trip = cur && cur.end >= today ? cur : null;
  return { today, live, trip };
}

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ctx = await load();
    const { today, live, trip } = await settle(ctx);
    const who = url.searchParams.get("who");
    const mine = WHO.includes(who) ? (live.find((v) => v.day === today && v.who === who) || {}).city || null : null;
    const voted = Object.fromEntries(WHO.map((w) => [w, live.some((v) => v.day === today && v.who === w)]));
    // le détail des votes n'est dévoilé qu'une fois le départ décidé
    return json({ today, thresh: THRESH, count: live.length, trip, trips: ctx.meta.trips, mine, voted });
  }
  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") || 0) > 500) return json({ error: "trop gros" }, 413);
    let b;
    try { b = await req.json(); } catch { return json({ error: "json invalide" }, 400); }
    if (!WHO.includes(b.who) || !CITIES.includes(b.city)) return json({ error: "demande invalide" }, 400);
    if (await jailRecord(b.who)) return json({ error: "Tu es en prison" }, 423);
    const ctx = await load();
    const s1 = await settle(ctx);
    if (s1.trip) return json({ error: "Un voyage est déjà décidé : le vote reprend au retour." }, 409);
    await ctx.st.set(`v/${s1.today}/${b.who}`, b.city);
    ctx.votes = ctx.votes.filter((v) => !(v.day === s1.today && v.who === b.who)).concat({ day: s1.today, who: b.who, city: b.city });
    const s2 = await settle(ctx);
    return json({ ok: true, count: s2.live.length, thresh: THRESH, trip: s2.trip });
  }
  return json({ error: "méthode non autorisée" }, 405);
};

export const config = { path: "/api/travel" };
