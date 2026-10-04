// The bottle assistant behind "Add your bottle".
//   step "label":    reads the label photo (Claude vision) into producer, wine, vintage, region
//   step "research": searches the web for the market price in SGD and writes a short background
// Research results are stored in bottle_lookups; the bottle row copies them
// from there (see bottles_guard), so a guest cannot type in a market price.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { currentUser, db, isAdmin, json, preflight } from "../_shared/common.ts";

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY, set with `supabase secrets set`
const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = 30; // lookups per guest per 24 hours, to keep costs predictable

// Opus 5.5 can decline on safety grounds; "default" re-runs a declined
// request on Anthropic's recommended fallback model inside the same call.
function ask(params: Record<string, unknown>) {
  return anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...params,
  } as Parameters<typeof anthropic.beta.messages.create>[0]) as Promise<Anthropic.Beta.Messages.BetaMessage>;
}

// ---------- label reader ----------

const LABEL_SYSTEM = `You read wine labels from photos for a private wine-dinner group in Singapore.
Report what the label shows. Use the producer's name as printed (for example "Domaine Armand Rousseau"),
and for the wine give the cuvee, appellation, vineyard and classification as they appear
(for example "Gevrey-Chambertin 1er Cru Clos Saint-Jacques"). Give the vintage as four digits, or "NV"
for a non-vintage wine, or "" if it is not visible. For the region give the appellation's region and
country in plain words (for example "Gevrey-Chambertin, Burgundy, France"). Use "" for anything you
cannot read; do not guess at text that is cut off or blurred, and mention it in "unsure" instead.
If the photo is not of a wine label, set is_wine_label to false.
When you are done, call record_label once.`;

const RECORD_LABEL = {
  name: "record_label",
  description: "Record what the wine label in the photo says. Call it exactly once, after reading the label.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      is_wine_label: { type: "boolean", description: "False if the photo is not a wine label." },
      producer: { type: "string", description: "Producer or estate as printed, or \"\"." },
      wine: { type: "string", description: "Cuvee / appellation / vineyard / classification, or \"\"." },
      vintage: { type: "string", description: "Four-digit year, \"NV\", or \"\" if not visible." },
      region: { type: "string", description: "Region and country, or \"\"." },
      colour: { type: "string", enum: ["red", "white", "rose", "sparkling", "sweet", "fortified", "unknown"] },
      unsure: { type: "string", description: "Anything that could not be read clearly, or \"\"." },
    },
    required: ["is_wine_label", "producer", "wine", "vintage", "region", "colour", "unsure"],
    additionalProperties: false,
  },
};

async function readLabel(imageUrl: string) {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{
    role: "user",
    content: [
      { type: "image", source: { type: "url", url: imageUrl } },
      { type: "text", text: "Read this label and record it with record_label." },
    ],
  }];
  return await untilToolCall("record_label", messages, {
    system: LABEL_SYSTEM,
    tools: [RECORD_LABEL],
    output_config: { effort: "low" },
  });
}

// ---------- market price and background ----------

const RESEARCH_SYSTEM = `You research wines for a private wine-dinner group in Singapore, where each guest
brings a bottle and the cost is shared. For the wine you are given, do two things.

1. Market price. Find what a 750 ml bottle of this wine and vintage typically sells for now, in
Singapore dollars. Prefer current retail listings from Singapore merchants and Wine-Searcher's average
price; use other markets only when Singapore has none, converting at today's rate and saying so.
If this exact vintage has no listings, use the nearest vintages and say so. Ignore auction lots,
magnums and other formats unless nothing else exists. Report a typical price and a low to high range,
in whole Singapore dollars, and a one-sentence basis (what you used, and when). Use 0 for all three
prices if you find nothing reliable. List up to four sources you actually used, with their URLs.

2. Background. Write 50 to 90 words of plain, factual prose for the guests: who makes it, where the
vineyard or appellation sits, what the vintage was like in that region, and whether it is likely to be
drinking well now. Only state what your sources support; if little is known, write less. No tasting
notes presented as fact, no scores, no marketing language, and no em or en dashes (use commas).

Search efficiently: a few well-chosen searches are enough. When you are done, call record_findings once.`;

const RECORD_FINDINGS = {
  name: "record_findings",
  description: "Record the market price and background for the wine. Call it exactly once, when the research is done.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      identified_as: { type: "string", description: "The wine you researched: producer, wine, vintage." },
      market_sgd: { type: "integer", description: "Typical price for a 750 ml bottle in SGD, or 0 if unknown." },
      low_sgd: { type: "integer", description: "Low end of the price range in SGD, or 0." },
      high_sgd: { type: "integer", description: "High end of the price range in SGD, or 0." },
      basis: { type: "string", description: "One sentence: what the price is based on, and when." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      sources: {
        type: "array",
        description: "Up to four sources actually used.",
        items: {
          type: "object",
          properties: { title: { type: "string" }, url: { type: "string" } },
          required: ["title", "url"],
          additionalProperties: false,
        },
      },
      background: { type: "string", description: "50 to 90 words for the guests." },
    },
    required: ["identified_as", "market_sgd", "low_sgd", "high_sgd", "basis", "confidence", "sources", "background"],
    additionalProperties: false,
  },
};

const WEB_SEARCH = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 5,
  user_location: { type: "approximate", country: "SG", city: "Singapore", timezone: "Asia/Singapore" },
};

async function research(w: { producer: string; wine: string; vintage: string; region: string }) {
  const described = [w.producer, w.wine, w.vintage || "vintage unknown", w.region].filter(Boolean).join(", ");
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{
    role: "user",
    content: `The wine: ${described}.\nFind its market price in Singapore and write the background, then call record_findings.`,
  }];
  return await untilToolCall("record_findings", messages, {
    system: RESEARCH_SYSTEM,
    tools: [WEB_SEARCH, RECORD_FINDINGS],
    output_config: { effort: "medium" },
  });
}

// Run until Claude calls the named recording tool. Server-side web search
// can pause a long turn (pause_turn): send the turn back and it resumes.
async function untilToolCall(
  tool: string,
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 4; i++) {
    const res = await ask({ ...params, messages });
    if (res.stop_reason === "refusal") throw new AssistError("assist_refused");
    for (const block of res.content) {
      if (block.type === "tool_use" && block.name === tool) {
        return block.input as Record<string, unknown>;
      }
    }
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: `Please record what you have with ${tool} now.` });
    }
  }
  throw new AssistError("assist_failed");
}

class AssistError extends Error {}

// the site's house style: no em or en dashes
function tidy(text: string): string {
  return String(text ?? "")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[–—]\s*/g, ", ")
    .trim();
}

const clip = (v: unknown, n = 200) => String(v ?? "").trim().slice(0, n);

// ---------- request handler ----------

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const user = await currentUser(req);
  if (!user) return json(req, { error: "not_signed_in" }, 401);

  const body = await req.json().catch(() => ({}));
  const { data: ev } = await db.from("events").select("*").eq("slug", body.slug ?? "").maybeSingle();
  if (!ev || ev.format !== "byob") return json(req, { error: "event_not_found" }, 404);

  // same rule as adding a bottle: a seat at the table (or Kai)
  const admin = await isAdmin(user);
  if (!admin) {
    const { data: seat } = await db.from("reservations").select("id")
      .eq("event_id", ev.id).eq("user_id", user.id).eq("status", "reserved").maybeSingle();
    if (!seat) return json(req, { error: "not_a_guest" }, 403);
  }

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from("bottle_lookups").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) return json(req, { error: "too_many_lookups" }, 429);

  try {
    if (body.step === "label") {
      const path = clip(body.photo_path, 300);
      if (!path.startsWith(`${user.id}/`)) return json(req, { error: "bad_photo" }, 400);
      const url = db.storage.from("labels").getPublicUrl(path).data.publicUrl;
      const label = await readLabel(url);
      await db.from("bottle_lookups").insert({
        event_id: ev.id, user_id: user.id, kind: "label", query: { photo_path: path }, result: label,
      });
      return json(req, { label });
    }

    if (body.step === "research") {
      const wine = {
        producer: clip(body.producer), wine: clip(body.wine),
        vintage: clip(body.vintage, 8), region: clip(body.region),
      };
      if (!wine.producer && !wine.wine) return json(req, { error: "nothing_to_look_up" }, 400);
      const f = await research(wine);
      const cents = (v: unknown) => (Number(v) > 0 ? Math.round(Number(v) * 100) : null);
      const result = {
        identified_as: tidy(f.identified_as as string),
        market_cents: cents(f.market_sgd),
        market_low_cents: cents(f.low_sgd),
        market_high_cents: cents(f.high_sgd),
        market_note: tidy(`${f.basis} Confidence: ${f.confidence}.`),
        confidence: f.confidence,
        sources: ((f.sources as { title: string; url: string }[]) ?? [])
          .filter((s) => /^https?:\/\//.test(s.url)).slice(0, 4)
          .map((s) => ({ title: clip(s.title, 120), url: s.url })),
        background: tidy(f.background as string),
      };
      const { data: row, error } = await db.from("bottle_lookups").insert({
        event_id: ev.id, user_id: user.id, kind: "research", query: wine, result,
      }).select("id").single();
      if (error) throw error;
      return json(req, { lookup_id: row.id, ...result });
    }

    return json(req, { error: "unknown_step" }, 400);
  } catch (e) {
    console.error("bottle-assist failed", e);
    if (e instanceof AssistError) return json(req, { error: e.message }, 502);
    if (e instanceof Anthropic.RateLimitError) return json(req, { error: "assist_busy" }, 503);
    return json(req, { error: "assist_failed" }, 502);
  }
});
