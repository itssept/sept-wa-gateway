# SEPT LEDGER v1.0 — Architecture & Migration Specification

## 1. Overview
SEPT LEDGER v1.0 replaces transient conversational contexts and wiki notes with an isolated PostgreSQL relational ledger per operator. It is the root fix for deal and invoice integrity issues (Room 4) and client status drift (Room 5).

## 2. Core Isolation & Architectural Rules
- **Physical Isolation**: Exactly one PostgreSQL database per operator seat. No `operator_id` column exists; the database boundary itself enforces tenant isolation.
- **Middleware Boundary**: The AI agent proposes structured draft objects; the middleware validates schemas, verifies permissions, and executes atomic SQL transactions.
- **Audit Immutability**: `raw_message` is permanently retained on `items` and `requests` for parse provenance and training.
- **Database Engine Triggers**:
  - `trg_prevent_locked_deal_mutation`: Enforces deal immutability when `is_locked = TRUE`.
  - `trg_prevent_locked_invoice_mutation`: Rejects modifications to locked invoice amounts or bank accounts.

## 3. Schema Structure
- `clients`: Counterparty profiles, preferences, and locations.
- `sources`: Sourcing channels and reliability ratings.
- `items`: Structured luxury inventory with protected operator-only fields (`cost`, `cost_currency`, `source_alias`).
- `requests`: Inbound client demand and standing alerts.
- `matches`: Bidirectional pairings between items and requests.
- `deals`: Transaction lifecycle management (`draft` -> `payment_pending` -> `paid` -> `fulfilled` / `disputed`).
- `invoices`: Formal billing records with locked operator banking details.
- `payments`: SWIFT and bank payment proof verification records.
- `corrections`: Audit log of operator overrides.
