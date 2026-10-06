// The bottle assistant behind "Add your bottle". Two short Claude calls per bottle, no web search:
//   step "label":    reads the label photo into producer, wine, vintage, region
//   step "describe": writes the background note for the line-up from the details the guest
//                    has checked and completed (so a vintage added by hand is in the note)
// There is no market price: the tally uses the price each guest shares their bottle for.
// Results are stored in bottle_lookups; the bottle row copies the background from
// there (see bottles_guard), so it is always the assistant's note, never typed text.
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { currentUser, db, isAdmin, json, preflight } from "../_shared/common.ts";

// ANTHROPIC_API_KEY, set with `supabase secrets set`. A key that is not tied to a
// workspace must name one on every request: set ANTHROPIC_WORKSPACE_ID for that.
const WORKSPACE = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
const anthropic = new Anthropic(WORKSPACE ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE } } : {});
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

// ---------- the background note ----------

const BACKGROUND_RULES = `The background is 40 to 80 words of plain, factual prose for guests at the dinner:
who makes the wine, where the vineyard or appellation sits, what the vintage was like in that region,
and whether it is likely to be drinking well now. Write it from what you know; there is no web search.
Only state facts you are confident are true of this producer and wine. If the producer is not one you
know well, keep to the appellation and the style of wine instead of guessing, and if you cannot say
anything reliable, leave the background as "". No tasting notes presented as fact, no scores, no
prices, no marketing language, and no em or en dashes (use commas).`;

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
  description: "Record what the wine label in the photo says. Call it exactly once.",
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

// ---------- background, from the details the guest confirmed ----------

const DESCRIBE_SYSTEM = `You write short background notes on wines for a private wine-dinner group in Singapore.

${BACKGROUND_RULES}

When you are done, call record_background once.`;

const RECORD_BACKGROUND = {
  name: "record_background",
  description: "Record the background note for the wine. Call it exactly once.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      background: { type: "string", description: "40 to 80 words for the line-up, or \"\"." },
    },
    required: ["background"],
    additionalProperties: false,
  },
};

async function describe(w: { producer: string; wine: string; vintage: string; region: string }) {
  const described = [w.producer, w.wine, w.vintage || "no vintage given (it may be non-vintage)", w.region].filter(Boolean).join(", ");
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{
    role: "user",
    content: `The wine: ${described}.\nWrite the background and record it with record_background.`,
  }];
  return await untilToolCall("record_background", messages, {
    system: DESCRIBE_SYSTEM,
    tools: [RECORD_BACKGROUND],
    output_config: { effort: "low" },
  });
}

// Run until Claude calls the named recording tool.
async function untilToolCall(
  tool: string,
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 3; i++) {
    const res = await ask({ ...params, messages });
    if (res.stop_reason === "refusal") throw new AssistError("assist_refused");
    for (const block of res.content) {
      if (block.type === "tool_use" && block.name === tool) {
        return block.input as Record<string, unknown>;
      }
    }
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: `Please record what you have with ${tool} now.` });
  }
  throw new AssistError("assist_failed");
}

class AssistError extends Error {}

// the site's house style: no em or en dashes
function tidy(text: unknown): string {
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
  // Kai is exempt, so the host page's label tester can be used freely
  if (!admin && (count ?? 0) >= DAILY_LIMIT) return json(req, { error: "too_many_lookups" }, 429);

  try {
    let query: Record<string, unknown>;
    let result: Record<string, unknown>;

    if (body.step === "label") {
      const path = clip(body.photo_path, 300);
      if (!path.startsWith(`${user.id}/`)) return json(req, { error: "bad_photo" }, 400);
      const url = db.storage.from("labels").getPublicUrl(path).data.publicUrl;
      const r = await readLabel(url);
      query = { photo_path: path };
      result = {
        is_wine_label: !!r.is_wine_label,
        producer: clip(r.producer), wine: clip(r.wine), vintage: clip(r.vintage, 8),
        region: clip(r.region), colour: r.colour, unsure: clip(r.unsure, 300),
      };
    } else if (body.step === "describe") {
      const wine = {
        producer: clip(body.producer), wine: clip(body.wine),
        vintage: clip(body.vintage, 8), region: clip(body.region),
      };
      if (!wine.producer && !wine.wine) return json(req, { error: "nothing_to_look_up" }, 400);
      const r = await describe(wine);
      query = wine;
      result = { background: tidy(r.background) };
    } else {
      return json(req, { error: "unknown_step" }, 400);
    }

    const { data: row, error } = await db.from("bottle_lookups").insert({
      event_id: ev.id, user_id: user.id, kind: "label", query, result,
    }).select("id").single();
    if (error) throw error;
    return json(req, { lookup_id: row.id, ...result });
  } catch (e) {
    console.error("bottle-assist failed", e);
    if (e instanceof AssistError) return json(req, { error: e.message }, 502);
    if (e instanceof Anthropic.RateLimitError) return json(req, { error: "assist_busy" }, 503);
    return json(req, { error: "assist_failed" }, 502);
  }
});
