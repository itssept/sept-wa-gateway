-- Migration 004: Client Status Corrections, Disambiguation & Lifecycle Enforcements
-- Target: PostgreSQL / SQLite Ledger Engine

-- 1. Counterparty entity table with strict disambiguation
CREATE TABLE IF NOT EXISTS counterparties (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    known_as TEXT,
    primary_phone TEXT,
    chat_context TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Client Requests with strict category typing
CREATE TABLE IF NOT EXISTS client_requests (
    id TEXT PRIMARY KEY,
    counterparty_id TEXT NOT NULL REFERENCES counterparties(id),
    category TEXT NOT NULL CHECK (category IN ('Bags', 'Apparel', 'Eyewear', 'Jewelry', 'Watches', 'Footwear', 'Lifestyle')),
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    specification_notes TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'matched', 'sourcing', 'sold_out', 'invoiced', 'fulfilled', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Deals with full financial and courier lifecycle tracking
CREATE TABLE IF NOT EXISTS luxury_deals (
    id TEXT PRIMARY KEY,
    counterparty_id TEXT NOT NULL REFERENCES counterparties(id),
    request_id TEXT REFERENCES client_requests(id),
    item_title TEXT NOT NULL,
    category TEXT NOT NULL,
    invoice_number TEXT UNIQUE,
    remitter_name TEXT,
    total_amount_gbp NUMERIC(12, 2),
    payout_recipient_id TEXT,
    payout_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payout_status IN ('unpaid', 'pending', 'paid', 'refunded')),
    tracking_number TEXT,
    courier_name TEXT,
    delivery_address TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN ('draft', 'invoiced', 'paid', 'dispatched', 'delivered', 'complete', 'sold_out')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Initial seed data for corrected client records
INSERT OR IGNORE INTO counterparties (id, full_name, known_as, chat_context)
VALUES 
    ('cp_mariam_lutfallah_01', 'Mariam Lutfallah', 'Mariam', 'Room 4'),
    ('cp_mariam_bucheeri_01', 'Mariam Bucheeri', 'Mariam', 'Room 5'),
    ('cp_dina_01', 'Dina', 'Dina', 'General'),
    ('cp_najla_01', 'Najla Alsaud', 'Najla', 'General'),
    ('cp_omar_01', 'Omar Walif Bibi', 'Omar', 'Operations');
