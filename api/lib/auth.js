import { createClient } from "@supabase/supabase-js";

const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // solo para verificar el token del cliente
  { auth: { persistSession: false } }
);

export async function requireAuth(req, res) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "No token" });
    return null;
  }
  const { data, error } = await supabasePublic.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
  return { id: data.user.id, email: data.user.email };
}
