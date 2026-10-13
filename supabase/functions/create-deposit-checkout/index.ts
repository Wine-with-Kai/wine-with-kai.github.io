// Reserve a seat: hold it (or waitlist the guest) and open a Stripe
// Checkout page for the deposit. The seat is confirmed by stripe-webhook.
import { currentUser, db, formatDate, json, preflight, SITE_URL, stripe } from "../_shared/common.ts";

const HOLD_MINUTES = 35;     // seat held while the guest pays
const CHECKOUT_MINUTES = 31; // Stripe's minimum lifetime is 30 minutes

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const user = await currentUser(req);
  if (!user) return json(req, { error: "not_signed_in" }, 401);

  const { slug, code } = await req.json().catch(() => ({}));
  const { data: ev } = await db.from("events").select("*").eq("slug", slug ?? "").maybeSingle();
  if (!ev) return json(req, { error: "event_not_found" }, 404);

  const { data: profile } = await db.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (!profile) return json(req, { error: "no_profile" }, 400);

  // the evening's seat code, if Kai set one (checked here, never sent to browsers)
  const { data: verdict } = await db.rpc("check_seat_code", { p_event: ev.id, p_user: user.id, p_code: code ?? "" });
  if (verdict === "wrong") return json(req, { error: "wrong_seat_code" }, 403);
  if (verdict === "locked") return json(req, { error: "too_many_code_tries" }, 429);

  // an earlier unpaid checkout for this seat is closed before a new one opens
  const { data: previous } = await db.from("reservations")
    .select("stripe_session_id").eq("event_id", ev.id).eq("user_id", user.id)
    .eq("status", "pending").maybeSingle();

  const { data: held, error } = await db.rpc("hold_seat", {
    p_event: ev.id,
    p_user: user.id,
    p_email: user.email ?? "",
    p_hold: `${HOLD_MINUTES} minutes`,
  });
  if (error) {
    const code = /event_not_open|deposit_not_set|event_started|not_invited/.exec(error.message)?.[0];
    return json(req, { error: code ?? "hold_failed" }, code ? 409 : 500);
  }
  const { reservation_id, outcome } = held[0];
  if (outcome !== "hold") return json(req, { outcome });

  if (previous?.stripe_session_id) {
    await stripe().checkout.sessions.expire(previous.stripe_session_id).catch(() => {});
  }

  const back = `${SITE_URL}/reserve.html?event=${encodeURIComponent(ev.slug)}`;
  const when = formatDate(ev.starts_at);
  try {
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      customer_email: user.email,
      client_reference_id: reservation_id,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: ev.currency,
          unit_amount: ev.deposit_cents,
          product_data: {
            name: `Seat deposit, ${ev.title}`,
            description: `${when}${ev.venue ? `, ${ev.venue}` : ""}. ` +
              `Fully refundable if you cancel at least ${ev.refund_days} days before the evening.`,
          },
        },
      }],
      metadata: { reservation_id, event_id: ev.id },
      payment_intent_data: { metadata: { reservation_id, event_id: ev.id } },
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
      success_url: `${back}&paid=1`,
      cancel_url: back,
    });
    await db.from("reservations").update({ stripe_session_id: session.id }).eq("id", reservation_id);
    return json(req, { outcome: "hold", url: session.url });
  } catch (e) {
    console.error("checkout failed", e);
    // release the seat again
    await db.from("reservations")
      .update({ status: "interested", hold_expires_at: null })
      .eq("id", reservation_id).eq("status", "pending");
    return json(req, { error: "checkout_failed" }, 502);
  }
});
