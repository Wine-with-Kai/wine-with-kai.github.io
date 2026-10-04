# Reservations and BYOB: setup

The site stays on GitHub Pages. Three new pages talk to a Supabase project
(database, email sign-in, label photos) and to Stripe (seat deposits):

| Page | For | What it does |
|---|---|---|
| `reserve.html` | guests | lists open evenings; `?event=<slug>` reserves a seat with a deposit, joins the waitlist, registers interest, cancels (refund if 14+ days ahead) |
| `byob.html?event=<slug>` | guests | price-range banner, the bottle line-up, add / edit your bottles, the cost tally |
| `admin.html` | Kai | create evenings, see guests, invitations, approve or decline bottles, tally and mark settled |

Server side, in this folder:

- `migrations/…_byob_reservations.sql`: tables, row level security, seat holds, waitlist order, line-up and tally functions, the `labels` photo bucket.
- `functions/create-deposit-checkout`: holds a seat (35 min) and opens Stripe Checkout for the deposit, or waitlists the guest when the table is full.
- `functions/stripe-webhook`: confirms the seat when Stripe reports the deposit paid; frees it if the checkout lapses.
- `functions/cancel-reservation`: cancels, refunding the deposit in full when it is at least `refund_days` (14) before the evening.
- `functions/bottle-assist`: the bottle assistant (Claude Opus 5.5). It reads the label photo, checks the market price in SGD with web search, and writes a short background. Results are stored in `bottle_lookups`, and a bottle copies them from there, so a guest cannot type in a market price.

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
1. **Photo.** When a guest photographs a label, it is shrunk to a JPEG and saved in the `labels` bucket. Claude reads the producer, wine, vintage and region into the form.
2. **Research.** Claude then searches the web, giving priority to Singapore merchants and Wine-Searcher. It returns:
   - a typical SGD price and a price range;
   - a basis and confidence for that price;
   - up to four sources;
   - a 50 to 90 word background.
3. **Guest check.** The guest checks everything and adds the bottle. If the "what you paid" field is empty, it is pre-filled with the market price.
4. **Who sees what:**
   - The background appears on the public line-up.
   - The market price sits next to what each guest paid, in a table only guests with a seat (and Kai) can see.
   - Kai's Bottles tab flags a declared price that is 30% or more away from the market price.
   - The tally always uses what the guest paid.
5. **Limits:**
   - Only guests with a seat can use the assistant.
   - Each guest gets 30 look-ups a day (`DAILY_LIMIT` in the function).
   - A full look-up (label plus research) is expected to cost roughly US$0.10 to US$0.40 in API usage and web searches. That is an estimate; check the Anthropic console after the first evening.
6. **Refusals.** Requests use `fallbacks: "default"`: if Opus 5.5 declines a request on safety grounds, the API retries it on Anthropic's recommended fallback model.
7. **When it fails**, the guest can still type the details and add the bottle without a market price.
