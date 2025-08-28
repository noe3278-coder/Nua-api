// /api/analyze.js — análisis determinista basado en datos reales (sin IA)

import { requireAuth } from "./lib/auth.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

/** Utils */
const EMO_FAMILY = {
  alegria: new Set(["Alegre","Tranquila","Feliz","Segura","Cariñosa","Apasionada","Inspirada","Motivada","Poderosa","Agradecida","Aliviada","Liberada","Emocionada","Ilusionada","Confiada","Aceptada","Respetada","Importante","Satisfecha","Esperanzada","Realizada","Optimista","Valiente","Orgullosa","Eufórica","Sensible","Curiosa","Juguetona","Deseada","Provocativa"]),
};
const isPositive = (name) => EMO_FAMILY.alegria.has(name);

/** Cuenta ocurrencias en un array */
function count(arr) {
  const m = new Map();
  for (const k of arr) m.set(k, (m.get(k) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

/** Resume por horas y días */
function timeBuckets(tsArr) {
  const byHour = Array(24).fill(0);
  const byDow = Array(7).fill(0); // 0=Dom, 1=Lun...
  for (const t of tsArr) {
    const d = new Date(Number(t));
    byHour[d.getHours()]++;
    byDow[d.getDay()]++;
  }
  return { byHour, byDow };
}

/** Genera un resumen prudente en lenguaje natural sin inventar */
function buildResumen(total, posPct, topAreasPos, topAreasNeg) {
  if (total === 0) return "Aún no hay registros para este rango.";
  const partes = [];
  partes.push(`Has registrado ${total} entradas en el periodo.`);
  partes.push(`Aproximadamente un ${Math.round(posPct)}% incluyen emociones agradables.`);
  if (topAreasPos.length) {
    const lista = topAreasPos.slice(0, 2).map(([a]) => a).join(" y ");
    partes.push(`Tienden a ser agradables cuando aparece: ${lista}.`);
  }
  if (topAreasNeg.length) {
    const lista = topAreasNeg.slice(0, 2).map(([a]) => a).join(" y ");
    partes.push(`Aparecen emociones desafiantes cuando surge: ${lista}.`);
  }
  return partes.join(" ");
}

export default async function handler(req, res) {
  const user = await requireAuth(req, res); if (!user) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 1) Rango temporal (ms)
    const now = Date.now();
    const from = Number(req.body?.range?.from ?? (now - 30 * 24 * 3600 * 1000));
    const to   = Number(req.body?.range?.to   ?? now);

    // 2) Leer entries reales del usuario
    const { data: rows, error } = await supabaseAdmin
      .from("entries")
      .select("*")
      .eq("user_id", user.id)
      .gte("event_ts", from)
      .lte("event_ts", to)
      .order("event_ts", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const entries = (rows || []);
    const total = entries.length;

    // 3) Derivados
    const tsList = entries.map(r => r.event_ts);
    const allEmos = entries.flatMap(r => (r.emotions || []).map(e => e.name));
    const pleasantCount = entries.filter(r => (r.emotions || []).some(e => isPositive(e.name))).length;

    const allAreas = entries.flatMap(r => r.life_areas || []);
    const areaCounts = count(allAreas); // [['Familia', 5], ...]
    const posAreas = count(
      entries.flatMap(r => (r.emotions || []).some(e => isPositive(e.name)) ? (r.life_areas || []) : [])
    );
    const negAreas = count(
      entries.flatMap(r => (r.emotions || []).some(e => !isPositive(e.name)) ? (r.life_areas || []) : [])
    );

    // Intensidades promedio por emoción
    const emoAgg = new Map(); // name -> {sum, n}
    for (const r of entries) {
      for (const e of (r.emotions || [])) {
        const cur = emoAgg.get(e.name) || { sum: 0, n: 0 };
        cur.sum += Number(e.intensity || 0);
        cur.n += 1;
        emoAgg.set(e.name, cur);
      }
    }
    const emoAvg = Array.from(emoAgg.entries())
      .map(([name, v]) => ({ name, avg: v.n ? v.sum / v.n : 0, n: v.n }))
      .sort((a, b) => b.avg - a.avg);

    // Buckets de tiempo
    const { byHour, byDow } = timeBuckets(tsList);
    const topHours = byHour
      .map((v, i) => ({ hour: i, v }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 2);
    const topDows = byDow
      .map((v, i) => ({ dow: i, v }))
      .filter(x => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 2);

    // 4) Construcción de insights (SIEMPRE basados en datos)
    const insights = {
      resumen_general: buildResumen(total, (pleasantCount / Math.max(1, total)) * 100, posAreas, negAreas),

      top_disparadores: areaCounts.slice(0, 3).map(([area, n]) => ({
        trigger: area,
        frecuencia: n
      })),

      patrones: [
        ... (topHours.length ? [{
          descripcion: `Franja horaria más registrada: ${topHours.map(h => `${h.hour}:00`).join(" y ")}`,
          evidencia: `${topHours.map(h => `${h.v} registro(s)`).join(" / ")}`
        }] : []),
        ... (topDows.length ? [{
          descripcion: `Días con más registros: ${topDows.map(d => ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"][d.dow]).join(" y ")}`,
          evidencia: `${topDows.map(d => `${d.v} registro(s)`).join(" / ")}`
        }] : []),
      ],

      creencias_limitantes: [], // Sin IA no inferimos creencias: evitamos inventar
      automatismos: [],         // Igual aquí: si no hay patrón explícito, mejor no sugerir

      recomendaciones: [],
    };

    // Recomendaciones prudentes (solo si hay señal)
    if (emoAvg.length) {
      const topIntensas = emoAvg.filter(e => e.avg >= 7 && e.n >= 2).slice(0, 3);
      if (topIntensas.length) {
        insights.recomendaciones.push(
          `Observa las emociones más intensas: ${topIntensas.map(e => `${e.name} (avg ${e.avg.toFixed(1)})`).join(", ")}. Registra posibles disparadores y prácticas que te ayuden.`
        );
      }
    }
    if (posAreas.length) {
      insights.recomendaciones.push(
        `Potencia lo que te sienta bien: ${posAreas.slice(0,2).map(([a]) => a).join(" y ")}.`
      );
    }
    if (negAreas.length) {
      insights.recomendaciones.push(
        `Planifica apoyos para contextos desafiantes: ${negAreas.slice(0,2).map(([a]) => a).join(" y ")}.`
      );
    }

    return res.json({ insights });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "No se pudo analizar los datos" });
  }
}

