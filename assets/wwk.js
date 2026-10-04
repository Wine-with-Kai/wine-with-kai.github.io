// Wine with Kai · shared helpers for the reservation, BYOB and admin pages.
// Needs supabase-js (UMD build) and wwk-config.js loaded first.
(function () {
  const cfg = window.WWK_CONFIG || {};
  const ready = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const client = ready
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        // implicit flow: the emailed link works even if opened in another browser
        auth: { flowType: "implicit", persistSession: true, detectSessionInUrl: true },
      })
    : null;

  const TZ = "Asia/Singapore";

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(cents, currency) {
    if (cents == null) return "";
    const sym = (currency || "sgd").toLowerCase() === "sgd" ? "S$" : (currency || "").toUpperCase() + " ";
    const neg = cents < 0;
    const abs = Math.abs(cents);
    const whole = abs % 100 === 0;
    const n = (abs / 100).toLocaleString("en-SG", {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    });
    return (neg ? "-" : "") + sym + n;
  }

  function parts(iso, opts) {
    const out = {};
    new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: TZ }, opts))
      .formatToParts(new Date(iso)).forEach((p) => { out[p.type] = p.value; });
    return out;
  }

  // "Thursday 8 October 2026 · 7:00 pm"
  function when(iso) {
    const d = parts(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return `${d.weekday} ${d.day} ${d.month} ${d.year} · ${time(iso)}`;
  }
  // "8 October 2026"
  function day(iso) {
    const d = parts(iso, { day: "numeric", month: "long", year: "numeric" });
    return `${d.day} ${d.month} ${d.year}`;
  }
  function time(iso) {
    const t = parts(iso, { hour: "numeric", minute: "2-digit", hour12: true });
    return `${t.hour}:${t.minute} ${(t.dayPeriod || "").toLowerCase()}`;
  }

  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // the last moment a cancellation still gets the deposit back
  function refundCutoff(ev) {
    return new Date(new Date(ev.starts_at).getTime() - ev.refund_days * 86400000);
  }

  const ERRORS = {
    not_signed_in: "Please sign in first.",
    no_profile: "Please add your name first.",
    event_not_found: "This evening could not be found.",
    event_not_open: "Reservations for this evening are not open.",
    deposit_not_set: "The deposit has not been set yet, so seats cannot be reserved just yet.",
    event_started: "This evening has already begun.",
    not_invited: "This evening is by invitation. Sign in with the email address your invitation was sent to.",
    not_a_guest: "The tally is shared with seated guests only.",
    checkout_failed: "The payment page could not be opened. Please try again in a moment.",
    refund_failed: "The refund could not be issued automatically. Kai has been told; nothing has been cancelled yet.",
    no_reservation: "There is no reservation to cancel.",
    too_many_lookups: "You have used today's bottle look-ups. Please type the details and Kai will check the price.",
    assist_refused: "The assistant could not help with this one.",
    assist_failed: "The assistant could not finish this time.",
    assist_busy: "The assistant is busy just now. Please try again in a minute.",
    nothing_to_look_up: "Add the producer or the wine first.",
    bad_photo: "That photo could not be used. Please try another.",
  };
  function errorText(e) {
    const code = (e && (e.code || e.message)) || String(e);
    for (const k in ERRORS) if (code.indexOf(k) !== -1) return ERRORS[k];
    return "Something went wrong: " + code;
  }

  // call an edge function; surfaces the { error } code it returns
  async function callFn(name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let code = error.message;
      try { code = (await error.context.json()).error || code; } catch (_) {}
      throw { code };
    }
    return data;
  }

  async function rpc(fn, args) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw error;
    return data;
  }

  async function user() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session ? data.session.user : null;
  }

  async function profile(u) {
    const { data } = await client.from("profiles").select("*").eq("id", u.id).maybeSingle();
    return data;
  }

  const LAST_EMAIL = "wwk-email";
  const remembered = () => { try { return localStorage.getItem(LAST_EMAIL) || ""; } catch (_) { return ""; } };
  const remember = (v) => { try { localStorage.setItem(LAST_EMAIL, v); } catch (_) {} };

  // Two steps on the same page: email, then the code from the email.
  // The email also carries a link, which signs in just as well.
  function signInForm(el, lead, onSignedIn) {
    el.innerHTML = `
      <p class="kicker">Sign in</p>
      <p>${lead || "Enter your email and we will send you a 6-digit code. No password needed."}</p>
      <form class="form" data-signin>
        <label>Email <input type="email" name="email" required autocomplete="email" value="${esc(remembered())}"></label>
        <div class="actions"><button class="btn small solid" type="submit">Email me a code</button></div>
        <p class="msg" data-msg aria-live="polite"></p>
      </form>
      <form class="form" data-code hidden>
        <label>The code from your email
          <input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}"
            maxlength="10" placeholder="123456" style="letter-spacing:0.3em; font-size:22px; max-width:220px;"></label>
        <div class="actions">
          <button class="btn small solid" type="submit">Sign in</button>
          <button class="linkish" type="button" data-again>Use another email</button>
        </div>
        <p class="msg" data-msg2 aria-live="polite"></p>
      </form>`;
    const form = el.querySelector("[data-signin]");
    const codeForm = el.querySelector("[data-code]");
    let email = "";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      const msg = form.querySelector("[data-msg]");
      btn.disabled = true;
      email = form.email.value.trim().toLowerCase();
      remember(email);
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.href.split("#")[0] },
      });
      btn.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = error.message; return; }
      form.hidden = true;
      codeForm.hidden = false;
      codeForm.querySelector("[data-msg2]").className = "msg ok";
      codeForm.querySelector("[data-msg2]").textContent = `We have emailed a code to ${email}. It can take a minute; check spam if it does not arrive.`;
      codeForm.code.focus();
    });
    codeForm.querySelector("[data-again]").addEventListener("click", () => {
      codeForm.hidden = true; form.hidden = false; form.email.focus();
    });
    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = codeForm.querySelector("button[type=submit]");
      const msg = codeForm.querySelector("[data-msg2]");
      btn.disabled = true;
      const { error } = await client.auth.verifyOtp({ email, token: codeForm.code.value.trim(), type: "email" });
      btn.disabled = false;
      if (error) { msg.className = "msg err"; msg.textContent = "That code did not work. Check it, or ask for a new one."; return; }
      if (onSignedIn) onSignedIn();
    });
  }

  function profileForm(el, u, onSaved) {
    el.innerHTML = `
      <p class="kicker">Welcome</p>
      <p>Signed in as <strong>${esc(u.email)}</strong>. What name should Kai put at the table?</p>
      <form class="form" data-profile>
        <div class="row">
          <label>Full name <input name="full_name" required autocomplete="name"></label>
          <label>Mobile <span class="hint">optional</span>
            <input name="phone" type="tel" autocomplete="tel"></label>
        </div>
        <div class="actions"><button class="btn small" type="submit">Continue</button></div>
        <p class="msg" data-msg aria-live="polite"></p>
      </form>`;
    const form = el.querySelector("[data-profile]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { error } = await client.from("profiles").insert({
        id: u.id, email: u.email,
        full_name: form.full_name.value.trim(),
        phone: form.phone.value.trim() || null,
      });
      if (error) {
        const msg = form.querySelector("[data-msg]");
        msg.className = "msg err"; msg.textContent = error.message; return;
      }
      onSaved();
    });
  }

  // Resolves to { user, profile } once the visitor is signed in and has a
  // profile; until then renders the sign-in or profile form into `el`.
  async function guest(el, onReady, lead) {
    const u = await user();
    if (!u) { signInForm(el, lead, onReady); return null; }
    let p = await profile(u);
    if (!p) {
      // invited by name: no need to ask again
      const { data: inv } = await client.from("invitations").select("name")
        .eq("email", (u.email || "").toLowerCase()).not("name", "is", null).limit(1);
      const name = inv && inv[0] && inv[0].name;
      if (name) {
        const { data } = await client.from("profiles")
          .insert({ id: u.id, email: u.email, full_name: name }).select().single();
        p = data;
      }
    }
    if (!p) { profileForm(el, u, onReady); return null; }
    return { user: u, profile: p };
  }

  function whoBar(el, g) {
    el.innerHTML = `Signed in as ${esc(g.profile.full_name)} &middot;
      <button class="linkish" type="button" data-signout>Sign out</button>`;
    el.querySelector("[data-signout]").addEventListener("click", async () => {
      await client.auth.signOut();
      location.reload();
    });
  }

  function notConfigured(el) {
    el.innerHTML = `<p class="muted" style="text-align:center;">Reservations open here soon.
      Until then, please let Kai know directly.</p>`;
  }

  // shrink a photo to a JPEG of at most 1600 px: quicker to upload, and a
  // format the label reader accepts (iPhone HEIC included, where the browser can decode it)
  async function shrinkImage(file) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
      return blob || file;
    } catch (_) {
      return file;
    }
  }

  async function event(slug) {
    const { data, error } = await client.from("events").select("*").eq("slug", slug || "").maybeSingle();
    if (error) throw error;
    return data;
  }

  window.WWK = {
    client, ready, esc, money, when, day, time, param, refundCutoff,
    errorText, callFn, rpc, user, profile, guest, whoBar, notConfigured, event, shrinkImage,
  };
})();
