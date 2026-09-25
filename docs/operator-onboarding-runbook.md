# Operator Onboarding Runbook (Issue 1 — Top Priority)

## Goal
A step-by-step onboarding guide Yara can follow alone in London starting 28 Sep 2026 to onboard personal shopping operators onto SEPT.

---

## 1. Operator Intake & What Yara Collects

### Information Collected:
1. **Full Name** (e.g. `Sarah Chen` or `Rakesh Emmadi`)
2. **WhatsApp Phone Number** in E.164 international standard (e.g. `+447123456789`, `+16504929990`, `+919962877238`)

*Note: No passwords, email addresses, or PromptQL accounts are required from the operator.*

### Where Yara Types It:
In any PromptQL bot chat (e.g. in `#general` or an onboarding thread).

### Exact Text Yara Types:
> *"Register operator Sarah Chen with phone +447123456789"*
> *(or for batch: "Register these numbers as operators: Sarah Chen +447123456789, Rakesh Emmadi +919962877238")*

---

## 2. Automated Provisioning Under the Hood (`register_operator`)

When invoked, the `register_operator` saved program automates the following steps end-to-end:
1. **Dedicated Workspace Room**: Creates `operator-<name-slug>` (e.g. `operator-sarah-chen`) under the `whatsapp-chats` parent room.
2. **Dedicated Scope & Permissions**: Provisions `operator-<name-slug>` scope and maps:
   - `general: true → manager`
   - `is_operator: true → writer`
   - `is_operator: false → reader`
3. **Service Accounts**: Creates `<Name> (Operator)` and `<Name> (Assistant)` bot users and attaches custom claims:
   - `operator_phone = <E.164>`
   - `is_operator = true` (for Operator SA) and `false` (for Assistant SA)
4. **Wiki Provisioning**: Generates `<Name> (WhatsApp Operator)` and linked service account identity pages, linked to `SEPT Operator Service Account Instructions`.
5. **Gateway Registration**: Calls `POST /api/v1/shoppers` on `sept-wa-gateway` with fresh MCP tokens.

*Important Invariant (Alignment with Room 12 & Room 13):*
Registration provisions accounts, workspace scoping, and gateway credentials only. **No automated welcome message is pushed upon registration.** The welcome greeting and initial capability guidance await the operator's first inbound direct message.

---

## 3. What the Operator Receives and Must Do

1. **Save Contact**: Yara sends the operator the **SEPT WhatsApp Gateway Number**: **`+1 (650) 313-4725`**. The operator saves this contact in their phone as **"SEPT"**.
2. **First Direct Message (Welcome Delivery Trigger)**: 
   - The operator opens a 1-on-1 WhatsApp chat with `+1 (650) 313-4725` and sends any greeting or message (e.g. *"Hey SEPT"* or *"Hi"*).
   - Per **Room 13 (Welcome message delivery)**, SEPT delivers the approved welcome greeting strictly as its **reply to this first 1:1 inbound DM**.
   - The welcome reply is sent once, never in group chats, and never unsolicited.

### Final Approved Operator Welcome Message Template (Room 12):
```text
Hi, this is SEPT.

I help you sell luxury — in the chats you already use.

I can:
* Remember pieces as they come in
* Match what’s available to the right clients
* Remember requests, sizes, prices, and open deals
* Track client shipments
* Draft messages in your voice, for your approval
* Prep invoices and payment summaries

I only see conversations I’m added to. Add me to the chats where you buy, sell, and talk to clients.

How can I help?
```
*(No error, support, or feedback lines in the welcome message — kept clean and focused strictly on value.)*

3. **Operator Feedback Prompt Rules**:
Do NOT ask for feedback or support in the welcome message. Trigger it only after the operator has actually used SEPT once so it feels earned:
- **Trigger Moments**:
  1. *After the first useful action* (first match, draft, or remembered piece) — short follow-up in that same chat.
  2. *Day 2 or 3* if they’ve been quiet but active — one soft check-in.
  3. *Never* on first touch, and *never* tied to an error.
- **Line to Use**:
  > *"Feedback for the team? Message Yara anytime."*
- **Delivery Invariant**: Send strictly **once** (record `feedback_prompt_sent` state), then stop. Never repeat daily.

4. **Add SEPT to Sourcer Groups**: The operator invites `+1 (650) 313-4725` to their luxury supplier/sourcer WhatsApp groups.
   - **Group Ownership**: The inviting operator is assigned permanent ownership of the group.
   - **History Replay**: WhatsApp group history is captured and silently ingested into their sealed ledger with `force_skip`.

---

## 4. Book Ingestion, Digests & Financial Flows

1. **Book Ingestion**: Ingestion is continuous and passive from chat streams. Forwarded supplier posts parse as `Inventory` and create stub `sourcers`. Client demands parse as `Requests` and `clients`.
2. **Morning Briefings / Digests**: Generated daily from passive ingestion, alerting on fresh stock (&le;7 days old), reminding on open requests (14 days untouched), and matching unprompted supply-demand pairs.
3. **Stripe & DHL Integration**: Operators send IBAN/Revolut/Stripe Connect IDs and DHL account numbers directly via WhatsApp chat. Invoices and DHL labels are prepared on the operator's account and delivered in chat for approval before sending.

---

## 5. Ongoing Management & Gaps

- **Idempotent Updates**: Re-running `register_operator` with the same phone updates details, refreshes claims, and rotates credentials seamlessly.
- **Deactivation**: Update gateway shopper status to `disabled` via `PUT /api/v1/shoppers/:id` and deactivate service accounts.
- **Gaps & Mitigations**:
  - *Subscription Payments*: Operators lack PromptQL console access. Yara sends hosted Stripe Customer Portal / Checkout links over WhatsApp.
  - *Carrier/Stripe Direct OAuth*: Captured conversationally in WhatsApp chat or via lightweight token links.
