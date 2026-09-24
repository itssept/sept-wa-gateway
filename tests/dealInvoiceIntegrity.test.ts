import { describe, expect, test } from "bun:test";
import {
  DealAndInvoiceManager,
  LockedInvoiceOverwriteError,
  PaymentMismatchError,
  InvalidPaymentDetailsSourceError,
} from "../src/modules/integrity/dealInvoiceIntegrity";

describe("Deal & Invoice Integrity Invariants", () => {
  const shreyProfile = {
    operator_id: "op_shrey_chettiar",
    operator_name: "Shrey Chettiar",
    receiving_accounts: {
      GBP: {
        bank_name: "HSBC UK Bank plc",
        account_name: "Shrey Chettiar Luxury Concierge",
        account_number: "48920184",
        sort_code: "40-02-18",
        iban: "GB29HBUK40021848920184",
        swift_bic: "HBUKGB41400",
      },
      EUR: {
        bank_name: "HSBC Continental Europe",
        account_name: "Shrey Chettiar Luxury Concierge",
        iban: "FR7630056000010000000000184",
        swift_bic: "CCBPFRPPXXX",
      },
    },
  };

  test("TEST 1: Locked-Invoice Overwrite Protection (Chanel Tote cannot overwrite Mariam Birkin INV-20328)", () => {
    const manager = new DealAndInvoiceManager(shreyProfile);
    manager.createDeal(
      "deal_mariam_birkin",
      "client_mariam",
      "Mariam",
      {
        brand: "Hermès",
        model: "Birkin 25",
        colour: "Craie",
        material: "Togo",
        hardware: "Gold Hardware (GHW)",
      },
      33000.0,
      29000.0,
      "GBP"
    );

    const invoice = manager.generateAndLockInvoice("deal_mariam_birkin", "INV-20328");
    expect(invoice.is_locked).toBe(true);
    expect(invoice.amount).toBe(33000.0);

    expect(() => {
      manager.updateDealOrInvoice("deal_mariam_birkin", { brand: "Chanel", model: "Tote" }, 7800.0, false);
    }).toThrow(LockedInvoiceOverwriteError);
  });

  test("TEST 2: Unassigned-Message Handling (Ambient message routes to unassigned state)", () => {
    const manager = new DealAndInvoiceManager(shreyProfile);
    manager.createDeal(
      "deal_mariam_birkin",
      "client_mariam",
      "Mariam",
      { brand: "Hermès", model: "Birkin 25" },
      33000.0,
      29000.0,
      "GBP"
    );
    manager.generateAndLockInvoice("deal_mariam_birkin", "INV-20328");

    const ambientMsg = {
      deal_id: "deal_mariam_birkin",
      sender: "+447911123456",
      text: "Hey check out this Chanel tote for £7,800 in stock now",
      extracted_data: { brand: "Chanel", model: "Tote", price: 7800 },
    };

    const result = manager.processIncomingMessage(ambientMsg);
    expect(result.status).toBe("unassigned");
    expect(manager.unassignedMessages.length).toBe(1);
    expect(manager.unassignedMessages[0].status).toBe("pending_operator_confirmation");
  });

  test("TEST 3: Payment Verification Checked Against Stored Invoice", () => {
    const manager = new DealAndInvoiceManager(shreyProfile);
    manager.createDeal(
      "deal_mariam_birkin",
      "client_mariam",
      "Mariam",
      { brand: "Hermès", model: "Birkin 25" },
      33000.0,
      29000.0,
      "GBP"
    );
    manager.generateAndLockInvoice("deal_mariam_birkin", "INV-20328");

    const mariamSwiftSlip = {
      paid_amount: 33000.0,
      currency: "GBP",
      beneficiary_name: "Shrey Chettiar Luxury Concierge",
      reference: "INV-20328 MARIAM",
    };

    const res = manager.verifyPayment("INV-20328", mariamSwiftSlip);
    expect(res.status).toBe("verified");
    expect(res.amount).toBe(33000.0);
  });

  test("TEST 4: Payment Details Sourcing Protection (Sourcer accounts prohibited)", () => {
    const manager = new DealAndInvoiceManager(shreyProfile);
    const details = manager.getOperatorPaymentDetails("GBP");
    expect(details.bank_name).toBe("HSBC UK Bank plc");

    const badProfile = {
      operator_id: "op_test",
      operator_name: "Test",
      receiving_accounts: {
        GBP: {
          bank_name: "Revolut / LDN Corporations Ltd (EDP)",
          account_name: "EDP Sourcing",
        },
      },
    };
    const badManager = new DealAndInvoiceManager(badProfile);
    expect(() => {
      badManager.getOperatorPaymentDetails("GBP");
    }).toThrow(InvalidPaymentDetailsSourceError);
  });
});
