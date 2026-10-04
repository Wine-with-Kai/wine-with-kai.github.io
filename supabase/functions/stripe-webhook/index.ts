// Stripe tells us when a deposit is paid (or a checkout lapses).
// Deploy with JWT verification off: Stripe signs the request instead.
import type Stripe from "npm:stripe@17.7.0";
import { cryptoProvider, db, stripe } from "../_shared/common.ts";

const SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

async function markPaid(s: Stripe.Checkout.Session) {
  const id = s.metadata?.reservation_id;
  if (!id) return;
  const { error } = await db.from("reservations").update({
    status: "reserved",
    paid_at: new Date().toISOString(),
    deposit_paid_cents: s.amount_total ?? 0,
    stripe_session_id: s.id,
    stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null,
    hold_expires_at: null,
  }).eq("id", id);
  if (error) throw error;
}

// the checkout lapsed or failed: free the seat, keep the guest as interested
async function release(s: Stripe.Checkout.Session) {
  const id = s.metadata?.reservation_id;
  if (!id) return;
  await db.from("reservations")
    .update({ status: "interested", hold_expires_at: null })
    .eq("id", id).eq("status", "pending").eq("stripe_session_id", s.id);
}

Deno.serve(async (req) => {
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      body, req.headers.get("stripe-signature") ?? "", SECRET, undefined, cryptoProvider,
    );
  } catch (e) {
    console.error("bad signature", e);
    return new Response("bad signature", { status: 400 });
  }

  const s = event.data.object as Stripe.Checkout.Session;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        if (s.payment_status === "paid") {
          await markPaid(s);
        } else if (s.metadata?.reservation_id) {
          // a delayed payment method: keep the seat a day while it clears
          await db.from("reservations")
            .update({ hold_expires_at: new Date(Date.now() + 86_400_000).toISOString() })
            .eq("id", s.metadata.reservation_id).eq("status", "pending");
        }
        break;
      case "checkout.session.async_payment_succeeded":
        await markPaid(s);
        break;
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        await release(s);
        break;
    }
  } catch (e) {
    console.error("webhook handling failed", event.type, e);
    return new Response("retry", { status: 500 }); // Stripe retries
  }
  return new Response("ok");
});
