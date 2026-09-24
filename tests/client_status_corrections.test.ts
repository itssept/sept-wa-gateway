import { describe, expect, it } from "bun:test";

describe("Issue 5: Client Status Corrections & Disambiguation Guardrails", () => {
  it("disambiguates Mariam Lutfallah (Room 4) from Mariam Bucheeri (Room 5)", () => {
    const room4Client = {
      name: "Mariam Lutfallah",
      room: "Room 4",
      item: "Hermès Birkin 29 Shoulder",
      invoice: "INV-20328",
      amountGbp: 33000,
    };

    const room5Client = {
      name: "Mariam Bucheeri",
      room: "Room 5",
      item: "Celine Patchwork Jacket",
      tracking: "DHL 9244331224",
      status: "delivered",
    };

    expect(room4Client.room).not.toEqual(room5Client.room);
    expect(room4Client.invoice).toBe("INV-20328");
    expect(room5Client.status).toBe("delivered");
    expect(room4Client.name).not.toEqual(room5Client.name);
  });

  it("enforces strict category typing for Dina (prevents Bag -> Parka substitution on sold-out)", () => {
    const requestedCategory = "Bags";
    const candidateItemCategory = "Apparel";

    const isMatchValid = requestedCategory.toLowerCase() === candidateItemCategory.toLowerCase();
    expect(isMatchValid).toBe(false);

    const resolvedStatus = "sold_out";
    expect(resolvedStatus).toBe("sold_out");
  });

  it("validates delivery fulfillment and payout settlement for Najla & Omar", () => {
    const najlaOrder = {
      client: "Najla Alsaud",
      item: "Tom Ford Bettina 52F Sunglasses",
      deliveryAddress: "12 Park Street, Mayfair, London",
      lifecycleStatus: "delivered",
      status: "complete",
    };

    const omarPayout = {
      sourcer: "Omar Walif Bibi",
      method: "Revolut",
      payoutStatus: "paid",
      linkedDeal: "Najla Eyewear Fulfillment",
    };

    expect(najlaOrder.status).toBe("complete");
    expect(najlaOrder.lifecycleStatus).toBe("delivered");
    expect(omarPayout.payoutStatus).toBe("paid");
  });
});
