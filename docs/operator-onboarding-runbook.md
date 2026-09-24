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

---

## 3. What the Operator Receives and Must Do

1. **Save Contact**: Yara sends the operator the **SEPT WhatsApp Gateway Number**: **`+1 (650) 313-4725`**. The operator saves this contact in their phone as **"SEPT"**.
2. **First Direct Message**: The operator opens a 1-on-1 WhatsApp chat with `+1 (650) 313-4725` and messages (e.g. *"Hey SEPT, I'm ready"*). The gateway binds the chat to their dedicated workspace room.
3. **Add SEPT to Sourcer Groups**: The operator invites `+1 (650) 313-4725` to their luxury supplier/sourcer WhatsApp groups.
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
