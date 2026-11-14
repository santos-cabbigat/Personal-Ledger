// Owner-issued reviewer credentials are isolated from the person's other Supabase logins.
import { createClient } from "npm:@supabase/supabase-js@2.86.0";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info" };
const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const reply = (body: object, status = 200) => Response.json(body, { status, headers: cors });
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  const owner = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: members, error: denied } = await owner.rpc("personal_ledger", { action: "listAccess", p: {} });
  if (denied) return reply({ error: "Only the ledger owner can manage people." }, 403);
  const input = await req.json();
  const email = String(input.email || "").trim().toLowerCase();
  const password = input.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith("@reviewer.invalid") || typeof password !== "string" ||
      password.length < 10 || new TextEncoder().encode(password).length > 72) return reply({ error: "Enter an email and a password of 10 to 72 bytes." }, 400);
  const member = members.find((m: { email: string }) => m.email === email);
  if ((member?.version ?? null) !== (input.version ?? null)) return reply({ error: "Access changed. Reopen the form." }, 409);
  // A fresh Auth identity also invalidates every previous session at the ledger boundary.
  const { data, error } = await admin.auth.admin.createUser({
    email: crypto.randomUUID() + "@reviewer.invalid", password, email_confirm: true, app_metadata: { ledger_reviewer: email }
  });
  if (error || !data.user) return reply({ error: "Could not create the reviewer login. Check the password and try again." }, 400);
  const saved = await owner.rpc("personal_ledger", { action: "saveAccess", p: {
    email, books: input.books, version: input.version, loginId: data.user.id
  } });
  if (saved.error) {
    // The request may have committed even if the response was lost. An unattached login has no ledger authority.
    if (saved.error.code === "P0001" || saved.error.code === "42501") await admin.auth.admin.deleteUser(data.user.id);
    return reply({ error: saved.error.message }, 409);
  }
  return reply({ saved: true });
});
