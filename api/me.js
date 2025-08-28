import { requireAuth } from "./lib/auth.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const user = await requireAuth(req, res); if (!user) return;

  if (req.method === "DELETE") {
    // Borra datos app-level
    const delCons = await supabaseAdmin.from("consents").delete().eq("user_id", user.id);
    const delEntries = await supabaseAdmin.from("entries").delete().eq("user_id", user.id);
    // Opcional: si mantenías fila en 'users' app-level
    // await supabaseAdmin.from("users").delete().eq("id", user.id);

    // Borra cuenta Auth (requiere service role)
    const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (delAuthErr) return res.status(500).json({ error: delAuthErr.message });

    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}
