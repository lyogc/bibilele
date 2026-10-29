import { getStore } from "@netlify/blobs";
import { jailRecord } from "./jail.mjs";

// Boutique du Baromètre du bonheur.
// Règle : chaque personne gagne 20 pièces par jour où elle a répondu (compté dans le carnet d'humeurs).
// Tout ce qui se dépense ou se donne est un événement ajouté au journal (jamais modifié) :
//   buy  {who, item}            gift {from, to, item, msg}        send {from, to, amount, msg}
// Le solde se recalcule toujours à partir du journal, donc deux personnes qui agissent en même
// temps ne peuvent pas s'écraser l'une l'autre.
// GET  /api/shop                      -> { balance, owned, equipped, events, catalog, daily }
// POST /api/shop {action, ...}        -> buy | gift | send | equip

const WHO = ["bilge", "lele"];
const DAILY = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// slot : pet | top (habit) | head (chapeau) | face (lunettes) | neck (écharpe)
export const CATALOG = {
  cat:      { price: 80,  slot: "pet" },
  dog:      { price: 80,  slot: "pet" },
  duck:     { price: 50,  slot: "pet" },
  pullvert: { price: 40,  slot: "top" },
  marin:    { price: 50,  slot: "top" },
  cuir:     { price: 70,  slot: "top" },
  paille:   { price: 40,  slot: "head" },
  couronne: { price: 120, slot: "head" },
  lunettes: { price: 30,  slot: "face" },
  echarpe:  { price: 30,  slot: "neck" },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function load() {
  const moods = getStore({ name: "humeurs-v1", consistency: "strong" });
  const shop = getStore({ name: "boutique-v1", consistency: "strong" });

  const days = { bilge: 0, lele: 0 };
  const { blobs: mb } = await moods.list();
  for (const { key } of mb) {
    const [day, who] = key.split("/");
    if (DAY.test(day) && WHO.includes(who)) days[who]++;
  }

  const { blobs: eb } = await shop.list({ prefix: "ev/" });
  const events = (
    await Promise.all(eb.map(async ({ key }) => { try { return JSON.parse(await shop.get(key)); } catch { return null; } }))
  ).filter(Boolean).sort((a, b) => a.t - b.t);

  const balance = { bilge: days.bilge * DAILY, lele: days.lele * DAILY };
  const owned = { bilge: [], lele: [] };
  for (const e of events) {
    if (e.type === "buy") { balance[e.who] -= CATALOG[e.item].price; owned[e.who].push(e.item); }
    if (e.type === "gift") { balance[e.from] -= CATALOG[e.item].price; owned[e.to].push(e.item); }
    if (e.type === "send") { balance[e.from] -= e.amount; balance[e.to] += e.amount; }
  }
  const equipped = { bilge: {}, lele: {} };
  for (const w of WHO) {
    try { equipped[w] = JSON.parse((await shop.get("eq/" + w)) || "{}") || {}; } catch { equipped[w] = {}; }
  }
  return { shop, balance, owned, equipped, events };
}

const other = (w) => (w === "bilge" ? "lele" : "bilge");
const clean = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 80);

export default async (req) => {
  if (req.method === "GET") {
    const { balance, owned, equipped, events } = await load();
    return json({
      daily: DAILY,
      catalog: Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, v.price])),
      balance, owned, equipped,
      events: events.filter((e) => e.type !== "buy").slice(-12).reverse(),
    });
  }

  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") || 0) > 2000) return json({ error: "trop gros" }, 413);
    let b;
    try { b = await req.json(); } catch { return json({ error: "json invalide" }, 400); }
    if (await jailRecord(b.who || b.from)) return json({ error: "Tu es en prison" }, 423);
    const st = await load();
    const { shop, balance, owned } = st;
    const add = (ev) => shop.set(`ev/${String(Date.now()).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ ...ev, t: Date.now() }));

    if (b.action === "buy") {
      const it = CATALOG[b.item];
      if (!WHO.includes(b.who) || !it) return json({ error: "demande invalide" }, 400);
      if (owned[b.who].includes(b.item)) return json({ error: "Tu l'as déjà" }, 409);
      if (balance[b.who] < it.price) return json({ error: "Pas assez de pièces" }, 402);
      await add({ type: "buy", who: b.who, item: b.item });
      return json({ ok: true });
    }
    if (b.action === "gift") {
      const it = CATALOG[b.item];
      if (!WHO.includes(b.from) || !it) return json({ error: "demande invalide" }, 400);
      const to = other(b.from);
      if (owned[to].includes(b.item)) return json({ error: "Il/elle l'a déjà" }, 409);
      if (balance[b.from] < it.price) return json({ error: "Pas assez de pièces" }, 402);
      await add({ type: "gift", from: b.from, to, item: b.item, msg: clean(b.msg) });
      return json({ ok: true });
    }
    if (b.action === "send") {
      if (!WHO.includes(b.from) || !Number.isInteger(b.amount) || b.amount < 1 || b.amount > 100000) return json({ error: "demande invalide" }, 400);
      if (balance[b.from] < b.amount) return json({ error: "Pas assez de pièces" }, 402);
      await add({ type: "send", from: b.from, to: other(b.from), amount: b.amount, msg: clean(b.msg) });
      return json({ ok: true });
    }
    if (b.action === "equip") {
      if (!WHO.includes(b.who)) return json({ error: "demande invalide" }, 400);
      const eq = { ...st.equipped[b.who] };
      if (b.item === null) {
        const slots = ["pet", "top", "head", "face", "neck"];
        if (!slots.includes(b.slot)) return json({ error: "demande invalide" }, 400);
        delete eq[b.slot];
      } else {
        const it = CATALOG[b.item];
        if (!it || !owned[b.who].includes(b.item)) return json({ error: "Objet non possédé" }, 403);
        eq[it.slot] = b.item;
      }
      await shop.set("eq/" + b.who, JSON.stringify(eq));
      return json({ ok: true });
    }
    return json({ error: "action inconnue" }, 400);
  }
  return json({ error: "méthode non autorisée" }, 405);
};

export const config = { path: "/api/shop" };
