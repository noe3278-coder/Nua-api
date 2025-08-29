// /api/analyze.js — análisis determinista + creencias por registro (enlazadas a emociones, patrones y áreas)

import { requireAuth } from "./lib/auth.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { getOpenAI } from "./lib/openai.js";

/* ===== Utilidades base (resumen y cuantitativo) ===== */
const EMO_FAMILY = {
  alegria: new Set([
    "Alegre","Tranquila","Feliz","Segura","Cariñosa","Apasionada","Inspirada","Motivada","Poderosa",
    "Agradecida","Aliviada","Liberada","Emocionada","Ilusionada","Confiada","Aceptada","Respetada",
    "Importante","Satisfecha","Esperanzada","Realizada","Optimista","Valiente","Orgullosa","Eufórica",
    "Sensible","Curiosa","Juguetona","Deseada","Provocativa"
  ]),
};
const isPositive = (name) => EMO_FAMILY.alegria.has(name);

function count(arr) {
  const m = new Map();
  for (const k of arr) m.set(k, (m.get(k) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}
function timeBuckets(tsArr) {
  const byHour = Array(24).fill(0);
  const byDow = Array(7).fill(0); // 0=Dom
  for (const t of tsArr) {
    const d = new Date(Number(t));
    if (Number.isNaN(d.getTime())) continue;
    byHour[d.getHours()]++;
    byDow[d.getDay()]++;
  }
  return { byHour, byDow };
}
function buildResumen(total, posPct, topAreasPos, topAreasNeg) {
  if (total === 0) return "Aún no hay registros para este rango.";
  const partes = [];
  partes.push(`Has registrado ${total} entradas en el periodo.`);
  partes.push(`Aproximadamente un ${Math.round(posPct)}% incluyen emociones agradables.`);
  if (topAreasPos.length) partes.push(`Tienden a ser agradables cuando aparece: ${topAreasPos.slice(0,2).map(([a])=>a).join(" y ")}.`);
  if (topAreasNeg.length) partes.push(`Aparecen emociones desafiantes cuando surge: ${topAreasNeg.slice(0,2).map(([a])=>a).join(" y ")}.`);
  return partes.join(" ");
}

/* ===== Heurística (fallback sin IA) por registro ===== */
function extractSentences(text) {
  return (text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}
function beliefsHeuristicForRecord(rec) {
  // Busca frases con absolutos o autoatribuciones negativas
  const tests = [
    /\b(no soy|no puedo|no valgo|no sirvo|no merezco|no me sale)\b/i,
    /\b(siempre|nunca|nadie|todos)\b/i,
    /\b(no me entienden|me van a rechazar|siempre me critican)\b/i,
    /\b(el mundo|la vida|todo es|siempre es|nunca es|la gente es)\b/i,
  ];
  const out = [];

  const pools = [
    { origen: "what_happened", texto: rec.what_happened || "" },
    { origen: "thoughts",      texto: rec.thoughts || "" },
    { origen: "reaction",      texto: rec.reaction || "" },
  ];

  for (const p of pools) {
    const frases = extractSentences(p.texto).slice(0, 10); // prudente
    for (const f of frases) {
      const lf = f.toLowerCase();
      if (tests.some(r => r.test(lf))) {
        out.push({ creencia: f, origen: p.origen });
      }
    }
  }
  return dedupeBy(out, (a) => `${a.creencia}::${a.origen}`);
}

/* ===== IA (batch) — detecta creencias por registro ===== */
function toBatchPayload(entries) {
  return entries.map((r, i) => ({
    id: r.id ?? r.entry_id ?? String(r.event_ts ?? i),
    what_happened: (r.what_happened || "").slice(0, 800),
    thoughts:      (r.thoughts || "").slice(0, 800),
    reaction:      (r.reaction || "").slice(0, 800),
  }));
}
function dedupeBy(list, keyFn) {
  const seen = new Set();
  const res = [];
  for (const item of list) {
    const k = keyFn(item);
    if (!seen.has(k)) { seen.add(k); res.push(item); }
  }
  return res;
}
async function detectBeliefsBatchAI(openai, entries) {
  if (!openai || !entries.length) return [];

  const payload = toBatchPayload(entries);
  const sys = `Eres un analista que detecta creencias limitantes en textos personales en español.
Debes señalar SOLO frases que aparezcan literalmente (o casi literalmente) en los textos del usuario.
Para cada registro (id), revisa what_happened, thoughts y reaction, y extrae posibles creencias limitantes.
No inventes, no parafrasees.`;

  const user = `Analiza y devuelve un JSON array con objetos:
{ "id": "<id del registro>", "creencia": "<frase literal>", "origen": "what_happened|thoughts|reaction" }

Textos por registro:
${JSON.stringify(payload, null, 2)}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  });

  let list = [];
  try {
    const content = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    // Permitimos tanto {"results":[...]} como [...]
    list = Array.isArray(parsed) ? parsed : (parsed.results || []);
  } catch {
    list = [];
  }

  // saneado básico
  return list.filter(x => x && x.id && x.creencia && x.origen);
}

/* ===== Handler principal ===== */
export default async function handler(req, res) {
  const user = await requireAuth(req, res); if (!user) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const now = Date.now();
    const from = Number(req.body?.range?.from ?? (now - 30 * 24 * 3600 * 1000));
    const to   = Number(req.body?.range?.to   ?? now);

    // 1) Leer BD
    let entries = [];
    const { data: rows, error } = await supabaseAdmin
      .from("entries")
      .select("*")
      .eq("user_id", user.id)
      .gte("event_ts", from)
      .lte("event_ts", to)
      .order("event_ts", { ascending: false });

    if (!error) entries = rows || [];
    else console.error("Supabase error:", error?.message);

    // 2) Fallback con registros locales
    if ((!entries || entries.length === 0) && Array.isArray(req.body?.records) && req.body.records.length) {
      entries = req.body.records.map((r, i) => ({
        id: r.id ?? String(r.ts ?? i),
        event_ts: r.ts ?? r.eventTs ?? (r.date ? Date.parse(r.date) : Date.now()),
        emotions: r.emotions || [],
        what_happened: r.whatHappened || "",
        thoughts: r.thoughts || "",
        reaction: r.reaction || "",
        life_areas: r.lifeAreas || []
      })).filter(e => !Number.isNaN(Number(e.event_ts)));
    }

    /* ====== Cuantitativo (igual que antes) ====== */
    const total = entries.length;
    const tsList = entries.map(r => r.event_ts);
    const pleasantCount = entries.filter(r => (r.emotions || []).some(e => isPositive(e.name))).length;

    const allAreas = entries.flatMap(r => r.life_areas || []);
    const areaCounts = count(allAreas);
    const posAreas = count(entries.flatMap(r => (r.emotions || []).some(e => isPositive(e.name)) ? (r.life_areas || []) : []));
    const negAreas = count(entries.flatMap(r => (r.emotions || []).some(e => !isPositive(e.name)) ? (r.life_areas || []) : []));

    const emoAgg = new Map();
    for (const r of entries) for (const e of (r.emotions || [])) {
      const cur = emoAgg.get(e.name) || { sum: 0, n: 0 };
      cur.sum += Number(e.intensity || 0); cur.n += 1; emoAgg.set(e.name, cur);
    }
    const emoAvg = Array.from(emoAgg.entries())
      .map(([name, v]) => ({ name, avg: v.n ? v.sum / v.n : 0, n: v.n }))
      .sort((a, b) => b.avg - a.avg);

    const { byHour, byDow } = timeBuckets(tsList);
    const topHours = byHour.map((v,i)=>({hour:i,v})).filter(x=>x.v>0).sort((a,b)=>b.v-a.v).slice(0,2);
    const topDows  = byDow.map((v,i)=>({dow:i,v})).filter(x=>x.v>0).sort((a,b)=>b.v-a.v).slice(0,2);

    /* ====== Detección de creencias por registro ====== */
    let beliefs = [];
    try {
      const openai = getOpenAI();
      if (openai) {
        // IA (batch único): devolvemos [{id, creencia, origen}, ...]
        const batch = await detectBeliefsBatchAI(openai, entries);
        beliefs = batch;
      } else {
        // Heurística por registro
        for (const r of entries) {
          const found = beliefsHeuristicForRecord(r).map(b => ({ id: r.id ?? r.entry_id, ...b }));
          beliefs.push(...found);
        }
      }
    } catch (e) {
      console.error("Belief detection error:", e);
      // Fallback final a heurística
      beliefs = [];
      for (const r of entries) {
        const found = beliefsHeuristicForRecord(r).map(b => ({ id: r.id ?? r.entry_id, ...b }));
        beliefs.push(...found);
      }
    }

    // Normalizamos IDs de entries para búsqueda rápida
    const byId = new Map();
    for (const r of entries) {
      const key = r.id ?? r.entry_id ?? String(r.event_ts);
      byId.set(String(key), r);
    }

    // Enlazamos cada creencia a su registro → emociones, patrones (textos) y áreas
    const creencias_limitantes = beliefs
      .map(b => {
        const rec = byId.get(String(b.id));
        if (!rec) return null;
        return {
          creencia: String(b.creencia || "").trim(),
          origen: b.origen, // por si quieres usarlo en el futuro
          emociones: (rec.emotions || []).map(e => e.name).filter(Boolean),
          patrones: {
            quePaso: (rec.what_happened || "").trim() || null,
            pensamientos: (rec.thoughts || "").trim() || null,
            reaccion: (rec.reaction || "").trim() || null,
          },
          areas: rec.life_areas || [],
        };
      })
      .filter(x => x && x.creencia);

    // Quitamos duplicados exactos creencia+patrones (misma ocurrencia)
    const creenciasDedup = dedupeBy(
      creencias_limitantes,
      (c) => `${c.creencia}::${(c.patrones?.quePaso||"").slice(0,60)}::${(c.patrones?.pensamientos||"").slice(0,60)}::${(c.patrones?.reaccion||"").slice(0,60)}`
    );

    /* ====== Construcción de respuesta ====== */
    const insights = {
      resumen_general: buildResumen(total, (pleasantCount / Math.max(1, total)) * 100, posAreas, negAreas),

      top_disparadores: areaCounts.slice(0, 3).map(([area, n]) => ({
        trigger: area,
        frecuencia: n
      })),

      patrones: [
        ...(topHours.length ? [{
          descripcion: `Franja horaria más registrada: ${topHours.map(h => `${h.hour}:00`).join(" y ")}`,
          evidencia: `${topHours.map(h => `${h.v} registro(s)`).join(" / ")}`
        }] : []),
        ...(topDows.length ? [{
          descripcion: `Días con más registros: ${topDows.map(d => ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"][d.dow]).join(" y ")}`,
          evidencia: `${topDows.map(d => `${d.v} registro(s)`).join(" / ")}`
        }] : []),
      ],

      // >>> NUEVO: cada ocurrencia de creencia enlazada a emociones, patrones (textos reales) y áreas
      creencias_limitantes: creenciasDedup,

      // No inferimos automatismos ni reencuadres aquí
      automatismos: [],
      recomendaciones: [],
    };

    if (emoAvg.length) {
      const topIntensas = emoAvg.filter(e => e.avg >= 7 && e.n >= 2).slice(0, 3);
      if (topIntensas.length) {
        insights.recomendaciones.push(
          `Observa las emociones más intensas: ${topIntensas.map(e => `${e.name} (avg ${e.avg.toFixed(1)})`).join(", ")}.`
        );
      }
    }
    if (posAreas.length) insights.recomendaciones.push(`Potencia lo que te sienta bien: ${posAreas.slice(0,2).map(([a])=>a).join(" y ")}.`);
    if (negAreas.length) insights.recomendaciones.push(`Planifica apoyos para contextos desafiantes: ${negAreas.slice(0,2).map(([a])=>a).join(" y ")}.`);

    return res.json({ insights });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "No se pudo analizar los datos" });
  }
}
