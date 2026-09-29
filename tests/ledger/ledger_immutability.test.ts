import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

describe("SEPT LEDGER v1.0 Immutability & Integrity Suite", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");

    // Initialize SQLite mirror of schema & immutability triggers
    db.run(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL,
        location TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        channel TEXT
      );

      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT NOT NULL,
        model TEXT,
        price NUMERIC(12,2),
        currency CHAR(3),
        source_id INTEGER REFERENCES sources(id),
        status TEXT DEFAULT 'available'
      );

      CREATE TABLE deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_reference TEXT UNIQUE NOT NULL,
        client_id INTEGER NOT NULL REFERENCES clients(id),
        item_id INTEGER NOT NULL REFERENCES items(id),
        agreed_price NUMERIC(12,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        status TEXT DEFAULT 'draft',
        is_locked BOOLEAN NOT NULL DEFAULT 0,
        locked_at TIMESTAMP
      );

      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT UNIQUE NOT NULL,
        deal_id INTEGER NOT NULL REFERENCES deals(id),
        client_id INTEGER NOT NULL REFERENCES clients(id),
        total_amount NUMERIC(12,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        beneficiary_name TEXT NOT NULL,
        bank_name TEXT NOT NULL,
        account_number_or_iban TEXT NOT NULL,
        status TEXT DEFAULT 'issued',
        is_locked BOOLEAN NOT NULL DEFAULT 1,
        locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id INTEGER NOT NULL REFERENCES deals(id),
        invoice_id INTEGER NOT NULL REFERENCES invoices(id),
        amount NUMERIC(12,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        payment_method TEXT NOT NULL,
        proof_reference TEXT,
        verified_status TEXT DEFAULT 'pending'
      );

      CREATE TRIGGER prevent_locked_deal_update
      BEFORE UPDATE ON deals
      FOR EACH ROW
      WHEN OLD.is_locked = 1 AND NEW.is_locked = 1 AND (
          NEW.item_id != OLD.item_id OR
          NEW.client_id != OLD.client_id OR
          NEW.agreed_price != OLD.agreed_price OR
          NEW.currency != OLD.currency
      )
      BEGIN
          SELECT RAISE(ABORT, 'CANNOT_MUTATE_LOCKED_DEAL: Deal is locked and financial/item terms cannot be overwritten.');
      END;

      CREATE TRIGGER prevent_locked_invoice_update
      BEFORE UPDATE ON invoices
      FOR EACH ROW
      WHEN OLD.is_locked = 1 AND (
          NEW.deal_id != OLD.deal_id OR
          NEW.client_id != OLD.client_id OR
          NEW.total_amount != OLD.total_amount OR
          NEW.currency != OLD.currency OR
          NEW.account_number_or_iban != OLD.account_number_or_iban
      )
      BEGIN
          SELECT RAISE(ABORT, 'CANNOT_MUTATE_LOCKED_INVOICE: Invoice is locked and immutable.');
      END;
    `);
  });

  it("should prevent ambient message from overwriting locked Birkin deal with Chanel tote (Room 4 incident)", () => {
    db.run("INSERT INTO clients (alias, location) VALUES ('Mariam', 'London')");
    db.run("INSERT INTO sources (name) VALUES ('Paris VIP Sourcing')");
    db.run("INSERT INTO items (brand, model, price, currency, source_id, status) VALUES ('Hermes', 'Birkin 25', 33000, 'GBP', 1, 'reserved')");
    db.run("INSERT INTO items (brand, model, price, currency, source_id, status) VALUES ('Chanel', 'Deauville Tote', 7800, 'GBP', 1, 'available')");

    // Create locked deal for Birkin (£33,000)
    db.run(`
      INSERT INTO deals (deal_reference, client_id, item_id, agreed_price, currency, status, is_locked)
      VALUES ('DEAL-20328', 1, 1, 33000, 'GBP', 'payment_pending', 1)
    `);

    // Create locked invoice INV-20328
    db.run(`
      INSERT INTO invoices (invoice_number, deal_id, client_id, total_amount, currency, beneficiary_name, bank_name, account_number_or_iban, is_locked)
      VALUES ('INV-20328', 1, 1, 33000, 'GBP', 'Shrey Chettiar', 'Barclays UK', 'GB12BARC20000012345678', 1)
    `);

    // Attempt to mutate deal with Chanel Tote item ID 2
    expect(() => {
      db.run("UPDATE deals SET item_id = 2, agreed_price = 7800 WHERE id = 1");
    }).toThrow(/CANNOT_MUTATE_LOCKED_DEAL/);

    // Attempt to mutate invoice amount
    expect(() => {
      db.run("UPDATE invoices SET total_amount = 7800 WHERE id = 1");
    }).toThrow(/CANNOT_MUTATE_LOCKED_INVOICE/);
  });

  it("should verify payment strictly against locked invoice total and reconcile deal", () => {
    db.run("INSERT INTO clients (alias) VALUES ('Mariam')");
    db.run("INSERT INTO items (brand, model, price, currency) VALUES ('Hermes', 'Birkin 25', 33000, 'GBP')");
    db.run("INSERT INTO deals (deal_reference, client_id, item_id, agreed_price, currency, status, is_locked) VALUES ('DEAL-20328', 1, 1, 33000, 'GBP', 'payment_pending', 1)");
    db.run("INSERT INTO invoices (invoice_number, deal_id, client_id, total_amount, currency, beneficiary_name, bank_name, account_number_or_iban, is_locked) VALUES ('INV-20328', 1, 1, 33000, 'GBP', 'Shrey', 'Barclays', 'GB123', 1)");

    const invoice = db.query("SELECT total_amount, currency FROM invoices WHERE invoice_number = 'INV-20328'").get() as { total_amount: number; currency: string };
    const swiftAmount = 33000;
    const swiftCurr = "GBP";

    expect(invoice.total_amount).toBe(swiftAmount);
    expect(invoice.currency).toBe(swiftCurr);

    db.run("INSERT INTO payments (deal_id, invoice_id, amount, currency, payment_method, proof_reference, verified_status) VALUES (1, 1, ?, ?, 'SWIFT', 'SWIFT-998811', 'verified')", [swiftAmount, swiftCurr]);
    db.run("UPDATE deals SET status = 'paid' WHERE id = 1");
    db.run("UPDATE invoices SET status = 'paid' WHERE id = 1");

    const deal = db.query("SELECT status FROM deals WHERE id = 1").get() as { status: string };
    expect(deal.status).toBe("paid");
  });
});
