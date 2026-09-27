# SEPT Operator Onboarding Runbook (London Launch — 28 September)
**Audience:** Yara Aldhaen (Operations / Leadership)  
**Goal:** Step-by-step procedure to onboard luxury personal shopping operators in London autonomously without engineering intervention.

---

## 1. Quick Checklist & Golden Rules

1. **Zero Unsolicited WhatsApp Messages:** Never send messages to an operator before they initiate contact. Registering an operator sends **nothing** over WhatsApp.
2. **First Contact via 1:1 Direct Message:** The operator must save SEPT's WhatsApp number (`+16503134725`) and send their first 1:1 message ("Hi" / "Hello" or their first request).
3. **Automated Welcome Response:** SEPT automatically replies to their first 1:1 DM with the clean, approved value template. No troubleshooting/error prompts.
4. **First Value Before Feedback:** The feedback prompt (*"Feedback for the team? Message Yara anytime."*) is triggered strictly once, only after SEPT performs its first successful action (e.g. match, piece logged, draft prepared).

---

## 2. Step 1: Registering the Operator

In the `#general` room (or any PromptQL bot chat), type the registration instruction:

```text
Register operator <Full Name> with phone <E.164 Phone Number>
```
*Example:* `Register operator Sarah Chen with phone +447123456789`

### What happens automatically under the hood:
- **Dedicated Room Provisioned:** `operator-sarah-chen` (public room under workspace).
- **Security Scopes & Data Isolation:** Private scope `operator-sarah-chen` and shared `operator-common` scope attached with role mappings (`is_operator=true` for human operator, `is_operator=false` for assistant).
- **Service Accounts Created:**
  - `Sarah Chen (Operator)` (claims: `operator_phone=+447123456789`, `is_operator=true`)
  - `Sarah Chen (Assistant)` (claims: `operator_phone=+447123456789`, `is_operator=false`)
- **Gateway Credentials Atomically Synced:** Registered on `sept-wa-gateway` with isolated MCP session tokens.
- **Delivery Guard Initialized:** Zero messages are sent to WhatsApp during this step.

---

## 3. Step 2: Operator Handshake & Contact Card

Provide the operator with the SEPT WhatsApp Gateway contact info:
- **SEPT WhatsApp Number:** `+1 650 313 4725`
- **Instruction to Operator:**
  > *"Save SEPT (+1 650 313 4725) in your phone contacts as **SEPT**. Send a quick 'Hi' on WhatsApp whenever you're ready."*

---

## 4. Step 3: Inbound Handshake & Approved Welcome Flow

### A. Operator's First Inbound 1:1 Message
When the operator messages SEPT directly for the first time:
- SEPT checks `operator_welcome_log`. Since `welcome_sent` is not yet recorded, SEPT delivers the approved welcome template:

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

- If the operator's first DM was a request (e.g., *"Can you find a Birkin 25 Togo in Gold?"*), SEPT sends the welcome message and immediately handles the request in the same turn.
- A timestamped `welcome_sent` record is committed in `operator_welcome_log`.
- Subsequent messages or greetings will **never** trigger the welcome message again.

---

## 5. Step 4: Loading Existing Client Books & Requests

To populate SEPT with the operator's historical client books and open requests:
1. **Direct DM Forwarding:** The operator forwards client requests or voice notes directly to the 1:1 SEPT chat.
2. **Sourcer Group Integration:** The operator adds SEPT (`+16503134725`) to their active WhatsApp sourcer / inventory groups.
   - SEPT establishes **Group Ownership** to the adding operator.
   - **Silent Group History Replay:** Automatically captures historical inventory messages without triggering duplicate alerts or spamming the group.
3. **Structured Ingestion in Operator Workspace:** All clients, open requests, and catalogued pieces appear in the dedicated `operator-<name>` room and ledger.

---

## 6. Step 5: Scheduling Daily Briefings & Digests

Scheduled routines run automatically for every registered operator:
- **Morning Briefing (08:30 Local Time):** Summary of active client requests, overnight sourcer drops, fresh matching inventory (≤7 days), and priority follow-ups.
- **Evening Digest (18:30 Local Time):** Summary of closed deals, open quotes awaiting payment, and pending sourcer confirmations.

---

## 7. Step 6: First Value & One-Time Feedback Prompt

- When SEPT completes its **first successful action** (e.g., matching a newly dropped piece to an open client request, or drafting a quote), it appends the single standard feedback prompt:
  > *"Feedback for the team? Message Yara anytime."*
- `feedback_prompt_sent` is recorded in `operator_welcome_log`. It is strictly once-per-operator and will never be sent again.

---

## 8. Billing & External Tools Authentication (Interim Policy)

### Current Operational Gap:
Operators interact 100% via WhatsApp and do not log into the PromptQL console dashboard. They cannot self-serve dashboard OAuth connections for Stripe/Revolut or carrier logins (DHL/FedEx).

### Approved Interim Procedures:
1. **Subscription & Service Billing:**
   - Handled via hosted Stripe Checkout / Customer Portal payment links sent directly to the operator via WhatsApp or email by Yara/Finance.
2. **Banking & Payout Coordinates:**
   - Receiving bank accounts / Revolut business details are captured conversationally in WhatsApp and securely recorded to the operator's private profile.
3. **Logistics & Carrier Accounts (DHL / FedEx):**
   - Carrier account numbers and pickup preferences are captured conversationally and configured in the operator's service account context.
4. **Status:**
   - Native self-serve UI authentication for operators remains **BLOCKED** on operator dashboard access; the conversational capture and Stripe portal link process is the official interim standard.

---

## 9. Verification & Diagnostics Matrix

| Check | Expected Behavior | Verification Query / Metric |
|---|---|---|
| **Registration** | No WhatsApp message sent | Outbound queue empty; no message event |
| **First 1:1 Inbound** | Approved welcome template delivered | `operator_welcome_log.welcome_sent` recorded |
| **Repeated 1:1 Inbound** | Normal conversational reply; no second welcome | `welcome_sent` timestamp preserved unchanged |
| **First Action Completed** | Feedback prompt sent exactly once | `operator_welcome_log.feedback_prompt_sent` recorded |
| **Group Add** | Group ownership assigned; silent history replay | Replay rows flagged `force_skip` (no bot trigger) |
