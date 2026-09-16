# Turning on real SMS (MSG91)

Students sign in with a phone number and a six-digit code. Until this is done, that code is
never sent: on a live deployment no student can sign in. The code in `src/sms/` is finished —
what is missing is an account and the paperwork India requires, and only the business can do
those. Expect the DLT approvals to take anywhere from a few days to a couple of weeks.

## What you need before starting

- The company's **PAN** and **GST certificate** (or incorporation certificate), and an
  authorised signatory's ID. DLT registration is for a business, not a person.
- A **six-letter sender header** you want messages to come from, e.g. `SAHYAK`. It must relate
  to the brand; operators reject headers that look like someone else's.

## 1. Register on a DLT portal (TRAI requirement)

Every commercial SMS in India must match a template registered on a DLT (Distributed Ledger
Technology) platform. Register once on **any one** operator's portal — Jio, Airtel, Vodafone Idea
(Vilpower) or BSNL — and it applies across all networks.

1. **Register the entity** (the business) as a *Principal Entity*. Upload PAN, GST and the
   authorisation letter. Note the **Entity ID** you receive.
2. **Register the header** (`SAHYAK` or your choice) as a *Transactional / Service* header.
3. **Register two content templates**, category *Service Implicit*, with **exactly** this text.
   `{#var#}` marks a variable. Do not add, remove or re-punctuate a single character — the
   operator compares the delivered message against this text and silently drops anything
   that does not match.

   **Sign-in code** — 1 variable:

   ```
   {#var#} is your Sahayak sign-in code. It works for 5 minutes. Do not share it with anyone.
   ```

   **Parent invitation** — 2 variables (the child's name, then the link):

   ```
   {#var#}'s school has invited you to see their progress on Sahayak. Open {#var#} to accept.
   ```

   Run `npx tsx --conditions=react-server scripts/sms-test-send.ts` to print the current text
   straight from `src/sms/templates.ts`. If that output and the registration ever differ, the
   registration wins and the code must change back.

4. The parent invitation contains a **link**. Operators now also require the link's domain to be
   whitelisted against your header — add your production domain in the portal's URL/CTA
   whitelisting section, or that message will not deliver even with an approved template.
5. Note each template's **DLT Template ID** once approved.

## 2. Set up MSG91

1. Create an account at msg91.com and complete their KYC. Add credit.
2. In **DLT settings**, enter your Entity ID and link the header.
3. Create one **Flow** (template) per message. Paste the same text, choose the matching DLT
   Template ID, and note the variable names MSG91 assigns (usually `VAR1`, `VAR2`).
4. Copy the **Auth Key** from the API section.

## 3. Configure the deployment

```bash
SMS_PROVIDER="msg91"
SMS_API_KEY="<MSG91 auth key>"
SMS_SENDER_ID="SAHYAK"                       # the registered header
SMS_TEMPLATE_LOGIN_CODE="<MSG91 flow/template id for the sign-in code>"
SMS_TEMPLATE_PARENT_INVITE="<MSG91 flow/template id for the invitation>"
# Only if MSG91 named the variables something other than VAR1, VAR2 (case-sensitive):
SMS_TEMPLATE_LOGIN_CODE_VARS=""
SMS_TEMPLATE_PARENT_INVITE_VARS=""
SMS_DAILY_CEILING="2000"                     # protects the bill; raise with real traffic
```

`SMS_PROVIDER="msg91"` with a missing key is a **fatal** error at boot on purpose — see
`src/config/environment.ts`. It means somebody meant to turn SMS on and mistyped a variable.

## 4. Send one test message

```bash
npx tsx --conditions=react-server scripts/sms-test-send.ts --to 98XXXXXXXX --send
```

It goes through the same `sendSms()` the product uses, so the attempt appears in the SMS ledger.
**"Accepted" is not "delivered"**: confirm the phone actually received it, and check MSG91's
delivery report. A message that MSG91 accepts and the operator drops (wrong template text,
unwhitelisted link, unlinked header) looks like a success everywhere except the phone.

Then sign in as a real student on the deployment, end to end, before telling a school it works.

## Development

Put `SMS_PROVIDER="log"` in `.env.development.local` — never in `.env`, which `npm start` also reads, and the boot check refuses to start a production server with `log`. Codes are printed to the server terminal — never to the browser.
