# Multi-Channel Invoice Delivery & Verification Runbook (Issue 9)

## Overview
This runbook establishes standard operating procedures and technical specifications for commercial invoice delivery across SEPT's client communication channels (WhatsApp and Instagram Direct).

---

## 1. Channel Delivery Architecture

### A. WhatsApp Direct Messages
- **Delivery Protocol**: Raw binary PDF document attachment via `sept-wa-gateway`'s `OutboundDispatcher` using PromptQL artifact references:
  ```xml
  <artifact type="file" identifier="sept_invoice_<deal_id>" />
  ```
- **Gateway Dispatch Mechanism**: `src/routing/outboundDispatcher.ts` attaches a real `application/pdf` as a WhatsApp document. The caption is one plain sentence: `Here is the commercial invoice.` If the model claims an invoice but emits no PDF — including an HTML artifact chip — the gateway downloads a stored thread PDF or builds a SEPT-branded PDF from invoice facts already in the turn (header is the word SEPT). If it cannot produce a real PDF, it sends `Preparing the invoice. I will send it in this chat when it is ready.` It never sends a bare `ql.app` invoice link or an HTML chip as a document, and it never says a PDF was sent when it was not.
- **Client Experience**: The client receives a native PDF attachment directly in chat, which opens in the device's native PDF viewer with zero external web navigation or link-unfurling warnings.

### B. Instagram Direct Messages
- **Problem**: Delivering bare web permalinks (`https://...`) in Instagram DMs triggers Meta's `l.instagram.com` **Link Shim** interstitial warning ("You're leaving Facebook/Instagram"), breaking luxury customer flow and raising security concerns.
- **Solution (In-Chat PNG Card + Direct Settlement)**:
  1. Generate a high-DPI rasterized PNG invoice card (1200x1600) containing the full commercial invoice breakdown (Order ID, Luxury Item Details, Condition, Settlement Account, Total).
  2. Deliver the image card natively in-chat:
     ```xml
     <artifact type="visualization" identifier="sept_invoice_image_<deal_id>" />
     ```
  3. Accompany the card with a clean Stripe payment link or wire routing reference.
- **Client Experience**: The client sees the full invoice breakdown directly in the thread without clicking any external link or encountering interstitial warnings.

---

## 2. Commercial Invoice Standards & Luxury Compliance

1. **Terminology Guardrails**:
   - Strictly forbidden: Resale/hype terminology (e.g., "BNIB", "store fresh", "resale markup", "sourcing fee surcharge").
   - Mandatory: Luxury commercial terms (e.g., "Condition: Pristine / Brand New with Box & Papers", "Total Amount: £24,500.00 (Inclusive of Handling & Insured Express Courier)").
2. **Settlement Bank Accounts**:
   - Invoices must strictly specify the **Operator / SEPT Direct Receiving Account** (e.g., SEPT Treasury Operations / Barclays Private Bank IBAN).
   - Never surface sourcer, EDP, or private reseller bank details.

---

## 3. Live Verification Procedure (Yara Friday Call)

1. **Step 1: Test Invoice Generation**:
   - Run `sept_multimodal_recognition` (`deal_execution_flow.py`) with a verified luxury order (e.g., Sara Al-Sabah - Hermès Birkin 25 Togo Gold).
   - Ensure both PDF (`sept_invoice_<id>`) and PNG (`sept_invoice_image_<id>`) artifacts are generated.
2. **Step 2: WhatsApp Live Gateway Test**:
   - Send the test trigger from the operator WhatsApp number to the SEPT gateway number:
     `"Generate invoice for Sara Al-Sabah Birkin deal"`
   - Confirm receipt of native PDF document attachment (`SEPT-INV-2026-TEST01_Sara_AlSabah.pdf`) with caption in WhatsApp.
   - Verify that no external `https://ql.app/l/...` permalink text appears in the message body.
3. **Step 3: Instagram Delivery Test**:
   - Verify that the generated PNG image card renders cleanly with readable typography on mobile screens.
