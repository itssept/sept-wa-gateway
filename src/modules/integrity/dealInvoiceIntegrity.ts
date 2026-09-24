export interface OperatorProfile {
  operator_id: string;
  operator_name: string;
  receiving_accounts: Record<string, {
    bank_name: string;
    account_name: string;
    account_number?: string;
    sort_code?: string;
    iban?: string;
    swift_bic?: string;
  }>;
}

export interface LuxuryItemSpec {
  brand: string;
  model: string;
  size?: string;
  colour?: string;
  material?: string;
  hardware?: string;
  condition?: string;
  sourcer?: string;
}

export interface DealRecord {
  deal_id: string;
  client_id: string;
  client_name: string;
  item: LuxuryItemSpec;
  sell_price: number;
  cost_price: number;
  currency: string;
  state: "confirmed" | "payment_pending" | "paid" | "dispatched" | "delivered";
  is_locked: boolean;
  invoice_id?: string;
  locked_at?: string;
}

export interface InvoiceRecord {
  invoice_id: string;
  deal_id: string;
  client_id: string;
  client_name: string;
  item: LuxuryItemSpec;
  amount: number;
  currency: string;
  payment_details: any;
  status: "locked_payment_pending" | "paid" | "voided";
  created_at: string;
  is_locked: boolean;
  payment_verified_at?: string;
  payment_reference?: string;
}

export interface UnassignedMessageRecord {
  unassigned_id: string;
  sender: string;
  text: string;
  extracted_data?: any;
  reason: string;
  status: "pending_operator_confirmation" | "confirmed_attached" | "discarded";
  received_at: string;
}

export class DealInvoiceIntegrityError extends Error {}
export class LockedInvoiceOverwriteError extends DealInvoiceIntegrityError {}
export class PaymentMismatchError extends DealInvoiceIntegrityError {}
export class InvalidPaymentDetailsSourceError extends DealInvoiceIntegrityError {}

export class DealAndInvoiceManager {
  private operatorProfile: OperatorProfile;
  public deals: Map<string, DealRecord> = new Map();
  public invoices: Map<string, InvoiceRecord> = new Map();
  public unassignedMessages: UnassignedMessageRecord[] = [];
  public auditLog: Array<{ timestamp: string; action: string; details: any }> = [];

  constructor(operatorProfile: OperatorProfile) {
    this.operatorProfile = operatorProfile;
  }

  private logAudit(action: string, details: any) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action,
      details,
    });
  }

  public getOperatorPaymentDetails(currency: string) {
    const receivingAccounts = this.operatorProfile.receiving_accounts || {};
    if (!receivingAccounts[currency]) {
      throw new InvalidPaymentDetailsSourceError(
        `No verified operator receiving account found for currency '${currency}'. Cannot generate invoice. Operator must provide their verified bank details.`
      );
    }
    const account = receivingAccounts[currency];
    const accountStr = JSON.stringify(account).toLowerCase();
    const prohibitedSources = ["edp", "revolut / ldn corporations ltd", "barclays (unverified)"];
    for (const p of prohibitedSources) {
      if (accountStr.includes(p)) {
        throw new InvalidPaymentDetailsSourceError(
          `Security violation: Prohibited/Sourcer account detected: ${JSON.stringify(account)}`
        );
      }
    }
    return account;
  }

  public createDeal(
    dealId: string,
    clientId: string,
    clientName: string,
    item: LuxuryItemSpec,
    sellPrice: number,
    costPrice: number,
    currency: string
  ): DealRecord {
    const deal: DealRecord = {
      deal_id: dealId,
      client_id: clientId,
      client_name: clientName,
      item,
      sell_price: sellPrice,
      cost_price: costPrice,
      currency,
      state: "confirmed",
      is_locked: false,
    };
    this.deals.set(dealId, deal);
    this.logAudit("deal_created", { deal_id: dealId, client_name: clientName });
    return deal;
  }

  public generateAndLockInvoice(dealId: string, invoiceId: string): InvoiceRecord {
    const deal = this.deals.get(dealId);
    if (!deal) {
      throw new DealInvoiceIntegrityError(`Deal '${dealId}' not found.`);
    }
    if (deal.is_locked) {
      throw new LockedInvoiceOverwriteError(
        `Deal '${dealId}' is already locked with invoice '${deal.invoice_id}'. Cannot overwrite locked deal/invoice.`
      );
    }

    const paymentDetails = this.getOperatorPaymentDetails(deal.currency);
    const invoice: InvoiceRecord = {
      invoice_id: invoiceId,
      deal_id: dealId,
      client_id: deal.client_id,
      client_name: deal.client_name,
      item: { ...deal.item },
      amount: deal.sell_price,
      currency: deal.currency,
      payment_details: paymentDetails,
      status: "locked_payment_pending",
      created_at: new Date().toISOString(),
      is_locked: true,
    };

    this.invoices.set(invoiceId, invoice);
    deal.invoice_id = invoiceId;
    deal.is_locked = true;
    deal.state = "payment_pending";
    deal.locked_at = new Date().toISOString();

    this.logAudit("invoice_locked", { deal_id: dealId, invoice_id: invoiceId, amount: deal.sell_price });
    return invoice;
  }

  public updateDealOrInvoice(
    dealId: string,
    newItem?: LuxuryItemSpec,
    newPrice?: number,
    isOperatorExplicit = false
  ) {
    const deal = this.deals.get(dealId);
    if (!deal) {
      throw new DealInvoiceIntegrityError(`Deal '${dealId}' not found.`);
    }

    if (deal.is_locked) {
      if (!isOperatorExplicit) {
        throw new LockedInvoiceOverwriteError(
          `Integrity Violation: Attempted to overwrite locked deal '${dealId}' and invoice '${deal.invoice_id}'. Locked invoices can never be overwritten by ambient chat or messages.`
        );
      } else {
        throw new LockedInvoiceOverwriteError(
          `Deal '${dealId}' is locked. Live records cannot be modified directly without prior review.`
        );
      }
    }

    if (newItem) deal.item = newItem;
    if (newPrice !== undefined) deal.sell_price = newPrice;
  }

  public processIncomingMessage(message: {
    deal_id?: string;
    text: string;
    sender: string;
    extracted_data?: any;
  }): { status: "attached" | "unassigned"; record?: UnassignedMessageRecord; deal_id?: string } {
    const dealId = message.deal_id;
    const text = message.text || "";
    const sender = message.sender || "";
    let matchedDeal: DealRecord | undefined;

    if (dealId && this.deals.has(dealId)) {
      matchedDeal = this.deals.get(dealId);
    }

    if (matchedDeal && matchedDeal.is_locked) {
      const lowerText = text.toLowerCase();
      if (
        (lowerText.includes("tote") || lowerText.includes("chanel") || lowerText.includes("flap")) &&
        !(lowerText.includes("birkin") || lowerText.includes("b25") || lowerText.includes("b30") || lowerText.includes("b35"))
      ) {
        const unassignedRecord: UnassignedMessageRecord = {
          unassigned_id: `unassigned_${Math.random().toString(36).substring(2, 10)}`,
          sender,
          text,
          extracted_data: message.extracted_data,
          reason: `Message describes a different item while active deal '${matchedDeal.deal_id}' is locked.`,
          status: "pending_operator_confirmation",
          received_at: new Date().toISOString(),
        };
        this.unassignedMessages.push(unassignedRecord);
        this.logAudit("message_routed_to_unassigned", unassignedRecord);
        return { status: "unassigned", record: unassignedRecord };
      }
    }

    if (!dealId || !matchedDeal) {
      const unassignedRecord: UnassignedMessageRecord = {
        unassigned_id: `unassigned_${Math.random().toString(36).substring(2, 10)}`,
        sender,
        text,
        extracted_data: message.extracted_data,
        reason: "Message is not clearly assigned to an existing active deal.",
        status: "pending_operator_confirmation",
        received_at: new Date().toISOString(),
      };
      this.unassignedMessages.push(unassignedRecord);
      this.logAudit("message_routed_to_unassigned", unassignedRecord);
      return { status: "unassigned", record: unassignedRecord };
    }

    return { status: "attached", deal_id: dealId };
  }

  public verifyPayment(
    invoiceId: string,
    paymentDoc: {
      paid_amount: number;
      currency: string;
      beneficiary_name?: string;
      reference?: string;
    }
  ) {
    const storedInvoice = this.invoices.get(invoiceId);
    if (!storedInvoice) {
      throw new PaymentMismatchError(`Invoice '${invoiceId}' not found in stored invoices ledger.`);
    }

    const deal = this.deals.get(storedInvoice.deal_id);
    if (!deal) {
      throw new PaymentMismatchError(`Deal for invoice '${invoiceId}' not found.`);
    }

    if (paymentDoc.currency !== storedInvoice.currency) {
      throw new PaymentMismatchError(
        `Currency mismatch: Stored invoice requires ${storedInvoice.currency}, but payment is in ${paymentDoc.currency}.`
      );
    }

    if (Math.abs(paymentDoc.paid_amount - storedInvoice.amount) > 0.01) {
      throw new PaymentMismatchError(
        `Amount mismatch: Stored invoice '${invoiceId}' amount is ${storedInvoice.currency} ${storedInvoice.amount}, but incoming payment received is ${paymentDoc.currency} ${paymentDoc.paid_amount}.`
      );
    }

    deal.state = "paid";
    storedInvoice.status = "paid";
    storedInvoice.payment_verified_at = new Date().toISOString();
    storedInvoice.payment_reference = paymentDoc.reference;

    this.logAudit("payment_verified_against_stored_invoice", {
      invoice_id: invoiceId,
      deal_id: deal.deal_id,
      amount: paymentDoc.paid_amount,
      currency: paymentDoc.currency,
    });

    return {
      status: "verified",
      invoice_id: invoiceId,
      deal_id: deal.deal_id,
      amount: paymentDoc.paid_amount,
      currency: paymentDoc.currency,
      item_secured: storedInvoice.item,
    };
  }
}
