# Reservations and BYOB: setup

The site stays on GitHub Pages. Three new pages talk to a Supabase project
(database, email sign-in, label photos) and to Stripe (seat deposits):

| Page | For | What it does |
|---|---|---|
| `reserve.html?event=<slug>` | guests | the one page per evening: sign in with an emailed 6-digit code, reserve (deposit or free), then, on BYOB evenings, photograph your label, the line-up and the tally. Without `?event` it lists open evenings |
| `byob.html` | old links | redirects to `reserve.html` |
| `admin.html` | Kai | evenings, guests, invitations by name with a WhatsApp button, bottle approvals, tally and settled ticks, and a "Test the bottle assistant" box |

Server side, in this folder:

- `migrations/…_byob_reservations.sql`: tables, row level security, seat holds, waitlist order, line-up and tally functions, the `labels` photo bucket.
- `functions/create-deposit-checkout`: holds a seat (35 min) and opens Stripe Checkout for the deposit, or waitlists the guest when the table is full.
- `functions/stripe-webhook`: confirms the seat when Stripe reports the deposit paid; frees it if the checkout lapses.
- `functions/cancel-reservation`: cancels, refunding the deposit in full when it is at least `refund_days` (14) before the evening.
- `functions/bottle-assist`: the bottle assistant (Claude Opus 5.5). In one call, with no web search, it reads the label photo and writes a short background note. The note is stored in `bottle_lookups`, and a bottle copies it from there.

## One-time setup

Steps 1 to 3 and 5 involve creating accounts and handling secret keys, so they are yours to do.

### 1. Supabase project
1. Create a project at supabase.com (region: Southeast Asia, Singapore).
2. **SQL Editor**: paste and run `migrations/20261004000000_byob_reservations.sql`.
3. Still in the SQL Editor, make yourself the host:
   ```sql
   insert into public.admins (email) values ('your-email@example.com');
   ```
4. **Authentication > URL Configuration**: Site URL `https://wine-with-kai.github.io`, and add the redirect URL `https://wine-with-kai.github.io/**`.
5. **Authentication > SMTP**: Supabase's built-in mailer only sends a handful of sign-in emails an hour. Before guests use it, connect a mail provider (Resend, Postmark, or similar).

### Sign-in emails
Under **Authentication > Emails > Templates**, both **Confirm sign up** (first-time guests) and **Magic link or OTP** (returning guests) use the subject `Your Wine with Kai sign-in code: {{ .Token }}` and show `{{ .Token }}` large in the body, with `{{ .ConfirmationURL }}` as a fallback link. Guests type the code on the page, so they never leave it. Run `migrations/20261005000000_invitation_names.sql` too (invitation names).

### Sign in with Google
Google Cloud project `wine-with-kai` (owner winewithkai@gmail.com), Google Auth Platform: app "Wine with Kai", External, **In production**, home page and `privacy.html` filled in, a Web client with origin `https://wine-with-kai.github.io` and redirect `https://hweaxketmosodctqpnme.supabase.co/auth/v1/callback`. Its client ID and secret are in Supabase under **Authentication > Sign In / Providers > Google**. `googleSignIn: true` in `assets/wwk-config.js` shows the button.

### 2. Point the site at it
**Project Settings > API**: copy the Project URL and the `anon` public key into `assets/wwk-config.js`. Both are public by design. **Never** put the `service_role` key there. Then run `python3 build.py`.

### 3. Stripe
1. Create or open the Stripe account (Singapore). Under **Settings > Payment methods**, turn on **PayNow** (and cards).
2. Under **Settings > Emails**, turn on receipts for successful payments and refunds.
3. Start in **test mode**: use the `sk_test_…` secret key.

### 4. Deploy the functions
```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set STRIPE_SECRET_KEY=sk_test_... SITE_URL=https://wine-with-kai.github.io
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy create-deposit-checkout
supabase functions deploy cancel-reservation
supabase functions deploy bottle-assist
# (config.toml turns the gateway JWT check off: each function checks the caller itself)
supabase functions deploy stripe-webhook
```

The Anthropic API key comes from console.anthropic.com (**API keys**). Set a monthly spend limit there too.

### 5. Stripe webhook
In Stripe, go to **Developers > Webhooks > Add endpoint**:
- URL: `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`

Copy its signing secret, then:
```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

### 6. Try it, then go live
Open `admin.html` and create an evening in **draft**. Set it to **open** and reserve a seat from another email address with Stripe's test card `4242 4242 4242 4242`. Then add a bottle, check the tally, and cancel to see the refund. When everything is right, repeat steps 4 and 5 with the live `sk_live_…` key and a live-mode webhook.

## How the money works
- **Deposit**: set per evening. A blank deposit means it is still to be decided: guests can only register interest. `0` means seats are confirmed with no payment.
- **Refunds**: cancelling on or before *start − refund_days* gets a full automatic refund. After that, the deposit is kept. Kai can refund anyway from the admin page. Stripe does not return its processing fee on refunds.
- **The tally** (BYOB):
  - total = every bottle brought (not declined) + the evening's shared costs
  - share = total ÷ seated guests
  - each guest's balance = share − their bottles − their deposit

  A positive balance is owed to Kai; a negative one is paid back to the guest. Settling the balances happens outside Stripe, and Kai ticks **settled** on the admin page.
- **Waitlist**: when a seat frees up, it goes to the waitlist in order before any newcomer. Guests see "a seat has opened for you" on the reservation page, but **no email is sent automatically**. Kai lets them know.

## The bottle assistant
- One Claude Opus 5.5 call per bottle, with **no web search and no market price**. The tally uses the price each guest chooses to share their bottle for, so a market price is not needed.
- **Photo:** the photo is shrunk to a JPEG and saved in the `labels` bucket. Claude reads the producer, wine, vintage and region into the form, and in the same call writes a 40 to 80 word background note from its own knowledge. It is told to keep to what it is sure of, to fall back to the appellation and style for producers it does not know well, and to leave the note empty rather than guess.
- **No photo:** "Write the background" does the same for a wine typed in by hand.
- **Guest check:** the guest sees the note before adding the bottle and can leave it out. It shows under the bottle on the public line-up.
- **Safeguards:** the note is stored in `bottle_lookups` and copied onto the bottle by `bottles_guard`, so it is always the assistant's text, from the guest's own look-up.
- **Limits and cost:** only seated guests can use it, 30 look-ups a day each (Kai exempt). Expect a few US cents per bottle.
- **Refusals:** requests use `fallbacks: "default"`, so a safety decline is retried on Anthropic's recommended fallback model.
- Apply `migrations/20261005010000_background_from_label.sql` after the earlier migrations.
