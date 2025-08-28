import { requireAuth } from "./lib/auth.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const user = await requireAuth(req, res); if (!user) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { records, range } = req.body || {};
  let data = records;

  if (!data) {
    const from = range?.from ?? Date.now() - 30 * 24 * 3600_000;
    const to = range?.to ?? Date.now();
    const { data: rows, error } = await supabaseAdmin
      .from("entries")
      .select("*")
      .eq("user_id", user.id)
      .gte("event_ts", from)
      .lte("event_ts", to)
      .order("event_ts", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    data = (rows || []).map(r => ({
      ts: r.event_ts,
      date: new Date(Number(r.event_ts)).toISOString(),
      emotions: r.emotions || [],
      whatHappened: r.what_happened || "",
      thoughts: r.thoughts || "",
      reaction: r.reaction || "",
      lifeAreas: r.life_areas || []
    }));
  }

  // MOCK de insights (sirve para probar Pantalla 13 sin costes de IA)
  return res.json({
    insights: {
      resumen_general: "Estado estable, con mejora en ocio y picos de estrés laboral.",
      top_disparadores: [{ trigger: "Trabajo", frecuencia: "alto" }, { trigger: "Familia", frecuencia: "medio" }],
      patrones: [{ descripcion: "Tensión lunes mañana", evidencia: "Más ira e inseguridad 8–11h" }],
      creencias_limitantes: [{ tipo: "Perfeccionismo", ejemplos: ["Tengo que hacerlo perfecto"], reencuadre: "Progreso > perfección" }],
      automatismos: [{ disparador: "Reuniones", respuesta: "tensión corporal", sugerencia: "respiración 4-7-8 previa" }],
      recomendaciones: ["Bloques de descanso 10’", "Caminata 20’ diaria"]
    }
  });
}
