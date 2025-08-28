import { z } from "zod";
import { requireAuth } from "../../api/lib/auth.js";
import { supabaseAdmin } from "../../api/lib/supabaseAdmin.js";

const EntryBody = z.object({
  eventTs: z.number().int().nonnegative(),
  emotions: z.array(z.object({
    name: z.string(),
    intensity: z.number().min(1).max(10),
    body: z.string().optional()
  })).nonempty(),
  whatHappened: z.string().optional(),
  thoughts: z.string().optional(),
  reaction: z.string().optional(),
  lifeAreas: z.array(z.string()).default([])
});

export default async function handler(req, res) {
  const user = await requireAuth(req, res); if (!user) return;

  if (req.method === "GET") {
    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Date.now();

    const { data, error } = await supabaseAdmin
      .from("entries")
      .select("*")
      .eq("user_id", user.id)
      .gte("event_ts", from)
      .lte("event_ts", to)
      .order("event_ts", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }

  if (req.method === "POST") {
    try {
      const parsed = EntryBody.parse(req.body);

      const { data, error } = await supabaseAdmin
        .from("entries")
        .insert({
          user_id: user.id,
          event_ts: parsed.eventTs,
          emotions: parsed.emotions,
          what_happened: parsed.whatHappened ?? null,
          thoughts: parsed.thoughts ?? null,
          reaction: parsed.reaction ?? null,
          life_areas: parsed.lifeAreas ?? []
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
}
