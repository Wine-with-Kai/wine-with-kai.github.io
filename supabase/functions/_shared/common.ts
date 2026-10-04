// Shared helpers for the Wine with Kai edge functions.
import Stripe from "npm:stripe@17.7.0";
import { createClient, type User } from "npm:@supabase/supabase-js@2";

// Created on first use: evenings without a deposit (and the bottle
// assistant) never touch Stripe, so they work before a Stripe key is set.
let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  stripeClient ??= new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  return stripeClient;
}
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

// service-role client: bypasses row level security, so every rule
// a guest must obey is checked here or inside the SQL functions
export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://wine-with-kai.github.io").replace(/\/$/, "");

// the site plus any extra origins (e.g. a local preview), comma separated
const ALLOWED = new Set(
  [SITE_URL, ...(Deno.env.get("EXTRA_ORIGINS") ?? "").split(",")]
    .map((o) => o.trim())
    .filter(Boolean),
);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(origin) ? origin : SITE_URL,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders(req) }) : null;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export async function currentUser(req: Request): Promise<User | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  return error ? null : data.user;
}

export async function isAdmin(user: User): Promise<boolean> {
  const { data } = await db.from("admins").select("email").eq("email", (user.email ?? "").toLowerCase()).maybeSingle();
  return !!data;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
