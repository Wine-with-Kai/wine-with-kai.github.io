// Give up a seat. The deposit is refunded in full when the guest cancels
// at least `refund_days` (14) days before the evening; later, it is kept.
// Kai (an admin) can cancel any reservation and may refund regardless.
import { currentUser, db, isAdmin, json, preflight, stripe } from "../_shared/common.ts";

const DAY = 86_400_000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const user = await currentUser(req);
  if (!user) return json(req, { error: "not_signed_in" }, 401);
  const admin = await isAdmin(user);

  const { slug, reservation_id, force_refund } = await req.json().catch(() => ({}));

  let query = db.from("reservations").select("*, events(*)").in("status", ["pending", "reserved"]);
  if (admin && reservation_id) {
    query = query.eq("id", reservation_id);
  } else {
    const { data: ev } = await db.from("events").select("id").eq("slug", slug ?? "").maybeSingle();
    if (!ev) return json(req, { error: "event_not_found" }, 404);
    query = query.eq("event_id", ev.id).eq("user_id", user.id);
  }
  const { data: r } = await query.maybeSingle();
  if (!r) return json(req, { error: "no_reservation" }, 404);

  const ev = r.events;
  const cutoff = new Date(ev.starts_at).getTime() - ev.refund_days * DAY;
  const inTime = Date.now() <= cutoff;

  let refund_status = "none";
  let refunded_cents = 0;

  if (r.status === "pending" && r.stripe_session_id) {
    await stripe().checkout.sessions.expire(r.stripe_session_id).catch(() => {});
  }

  if (r.status === "reserved" && r.deposit_paid_cents > 0) {
    if ((inTime || (admin && force_refund)) && r.stripe_payment_intent) {
      try {
        const refund = await stripe().refunds.create(
          { payment_intent: r.stripe_payment_intent, metadata: { reservation_id: r.id } },
          { idempotencyKey: `refund-${r.id}` },
        );
        refund_status = "refunded";
        refunded_cents = refund.amount;
      } catch (e) {
        console.error("refund failed", e);
        return json(req, { error: "refund_failed" }, 502);
      }
    } else {
      refund_status = "forfeited";
    }
  }

  const { error } = await db.from("reservations").update({
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    hold_expires_at: null,
    refund_status,
    refunded_cents,
  }).eq("id", r.id);
  if (error) return json(req, { error: "update_failed" }, 500);

  return json(req, { refund_status, refunded_cents });
});
