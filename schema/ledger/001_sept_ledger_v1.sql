-- ====================================================================
-- SEPT LEDGER v1.0 — PostgreSQL Production Schema
-- Multi-operator Isolated Schema (One Database Per Operator)
-- ====================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. CORE TABLES

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    alias TEXT NOT NULL,
    phone_hash TEXT,
    language TEXT DEFAULT 'en',
    location TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT, -- 'whatsapp group', 'direct chat', 'boutique', 'reseller'
    typically_carries TEXT,
    reliability_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    brand TEXT NOT NULL,
    model TEXT,
    size TEXT,
    colour TEXT,
    material TEXT,
    hardware TEXT,
    condition TEXT,
    defects TEXT,
    full_set BOOLEAN DEFAULT FALSE,
    stamp TEXT,
    price NUMERIC(12,2),
    currency CHAR(3),
    -- Operator-Only Fields (Protected)
    cost NUMERIC(12,2),
    cost_currency CHAR(3),
    source_alias TEXT,
    location TEXT,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('coming', 'available', 'reserved', 'on_hold', 'sold', 'expired', 'resurfaced')),
    sold_price NUMERIC(12,2),
    sold_currency CHAR(3),
    sold_to_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    sold_at TIMESTAMPTZ,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_message TEXT, -- Immutable audit trail & training data
    media_refs TEXT[], -- Pointers to images/storage URLs
    parse_confidence NUMERIC(3,2) CHECK (parse_confidence >= 0.00 AND parse_confidence <= 1.00),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requests (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, -- NULL = standing alert
    is_standing_alert BOOLEAN NOT NULL DEFAULT FALSE,
    brand TEXT,
    model TEXT,
    size TEXT,
    colour TEXT,
    material TEXT,
    hardware TEXT,
    budget NUMERIC(12,2),
    currency CHAR(3),
    flexibility_notes TEXT,
    urgency TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'matched', 'offered', 'confirmed', 'dead')),
    closed_reason TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    last_client_contact TIMESTAMPTZ,
    raw_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deals (
    id SERIAL PRIMARY KEY,
    deal_reference TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    agreed_price NUMERIC(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    cost NUMERIC(12,2), -- Operator-only
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'payment_pending', 'paid', 'fulfilled', 'cancelled', 'disputed')),
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    invoice_number TEXT UNIQUE NOT NULL,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    client_id INTEGER NOT NULL REFERENCES clients(id),
    total_amount NUMERIC(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    beneficiary_name TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    account_number_or_iban TEXT NOT NULL,
    swift_bic TEXT,
    status TEXT NOT NULL DEFAULT 'issued'
        CHECK (status IN ('draft', 'issued', 'paid', 'voided')),
    is_locked BOOLEAN NOT NULL DEFAULT TRUE,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pdf_artifact_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    amount NUMERIC(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'SWIFT',
    proof_reference TEXT, -- SWIFT MT103 reference or slip hash
    verified_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (verified_status IN ('pending', 'verified', 'disputed', 'rejected')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'near')),
    difference TEXT,
    rank_score NUMERIC(5,2),
    status TEXT NOT NULL DEFAULT 'surfaced'
        CHECK (status IN ('surfaced', 'drafted', 'offered', 'confirmed', 'dead')),
    surfaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (item_id, request_id)
);

CREATE TABLE IF NOT EXISTS corrections (
    id SERIAL PRIMARY KEY,
    target_table TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    raw_message TEXT,
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. INDEXES
CREATE INDEX IF NOT EXISTS idx_items_search ON items (brand, model, status);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status, last_confirmed_at);
CREATE INDEX IF NOT EXISTS idx_requests_search ON requests (brand, model, status);
CREATE INDEX IF NOT EXISTS idx_requests_open ON requests (status, opened_at);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches (status, surfaced_at);
CREATE INDEX IF NOT EXISTS idx_deals_client ON deals (client_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_deal ON invoices (deal_id);

-- 4. DB-LEVEL IMMUTABILITY & INTEGRITY ENFORCEMENT TRIGGERS

CREATE OR REPLACE FUNCTION fn_prevent_locked_deal_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_locked = TRUE AND NEW.is_locked = TRUE THEN
        IF (NEW.item_id <> OLD.item_id OR
            NEW.client_id <> OLD.client_id OR
            NEW.agreed_price <> OLD.agreed_price OR
            NEW.currency <> OLD.currency) THEN
            RAISE EXCEPTION 'CANNOT_MUTATE_LOCKED_DEAL: Deal % is locked. Financial and item terms cannot be overwritten.', OLD.deal_reference;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_locked_deal_mutation ON deals;
CREATE TRIGGER trg_prevent_locked_deal_mutation
BEFORE UPDATE ON deals
FOR EACH ROW
EXECUTE FUNCTION fn_prevent_locked_deal_mutation();

CREATE OR REPLACE FUNCTION fn_prevent_locked_invoice_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_locked = TRUE THEN
        IF (NEW.deal_id <> OLD.deal_id OR
            NEW.client_id <> OLD.client_id OR
            NEW.total_amount <> OLD.total_amount OR
            NEW.currency <> OLD.currency OR
            NEW.account_number_or_iban <> OLD.account_number_or_iban) THEN
            RAISE EXCEPTION 'CANNOT_MUTATE_LOCKED_INVOICE: Invoice % is immutable and locked.', OLD.invoice_number;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_locked_invoice_mutation ON invoices;
CREATE TRIGGER trg_prevent_locked_invoice_mutation
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION fn_prevent_locked_invoice_mutation();
