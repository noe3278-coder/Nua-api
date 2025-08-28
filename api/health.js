export default function handler(_req, res) {
  res.json({ ok: true, time: Date.now() });
}
