"""
SEPT Client Status Corrections & Identity Disambiguation Module (Issue 5)
Handles client status reconciliations, counterparty identity disambiguation,
and category matching invariants across the SEPT luxury ledger.
"""

import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

# Structured records of verified client status corrections
CORRECTED_CLIENT_RECORDS: Dict[str, Dict[str, Any]] = {
    "Dina": {
        "client_name": "Dina",
        "requested_item": "Chanel Bag",
        "requested_category": "Bags",
        "rejected_substitutions": ["Karl Lagerfeld Vintage Parka"],
        "lifecycle_status": "sold_out",
        "action_required": "Source alternative Chanel Bags via sourcer network; do not substitute apparel/RTW.",
        "verified_resolution": "Request marked sold_out; vintage parka decoupled."
    },
    "Mariam Bucheeri": {
        "client_name": "Mariam Bucheeri",
        "counterparty_id": "cp_mariam_bucheeri_01",
        "chat_context": "Room 5",
        "active_item": "Celine Patchwork Jacket",
        "category": "Apparel",
        "tracking_number": "DHL 9244331224",
        "lifecycle_status": "delivered",
        "next_action": "Pitch matching Celine companion bag (operator sign-off required)",
        "verified_resolution": "Status updated to delivered; companion bag outreach prepared for operator sign-off."
    },
    "Mariam Lutfallah": {
        "client_name": "Mariam Lutfallah",
        "counterparty_id": "cp_mariam_lutfallah_01",
        "chat_context": "Room 4",
        "active_item": "Hermès Birkin 29 Shoulder",
        "category": "Bags",
        "invoice_number": "INV-20328",
        "remitter_name": "Mrs. Hana Hasan Ali Alaali",
        "total_amount_gbp": 33000.00,
        "lifecycle_status": "invoiced_and_secured",
        "verified_resolution": "Maintained strictly separate from Mariam Bucheeri."
    },
    "Najla Alsaud": {
        "client_name": "Najla Alsaud",
        "counterparty_id": "cp_najla_alsaud_01",
        "active_item": "Tom Ford Bettina 52F Sunglasses",
        "category": "Eyewear",
        "delivery_address": "12 Park Street, Mayfair, London",
        "courier": "Omar Walif Bibi",
        "lifecycle_status": "delivered",
        "status": "complete",
        "verified_resolution": "Order marked 100% complete and fulfilled."
    },
    "Omar Walif Bibi": {
        "client_name": "Omar Walif Bibi",
        "role": "Sourcer / Courier",
        "payout_method": "Revolut",
        "associated_fulfillment": "Najla Alsaud Eyewear",
        "payout_status": "paid",
        "verified_resolution": "Sourcer payout voucher marked paid against fulfilled deal."
    }
}

class CounterpartyDisambiguator:
    """
    Prevents cross-contamination between clients sharing first names (e.g. Mariam in Room 4 vs Mariam Bucheeri in Room 5).
    """
    @staticmethod
    def disambiguate_mariam(room_context: str, invoice_ref: Optional[str] = None, item_category: Optional[str] = None) -> Dict[str, Any]:
        if room_context == "Room 4" or invoice_ref == "INV-20328" or item_category == "Bags":
            return CORRECTED_CLIENT_RECORDS["Mariam Lutfallah"]
        elif room_context == "Room 5" or item_category == "Apparel" or invoice_ref is None:
            return CORRECTED_CLIENT_RECORDS["Mariam Bucheeri"]
        raise ValueError(f"Ambiguous context for Mariam: room={room_context}, invoice={invoice_ref}, category={item_category}")

class CategoryMatchingGuardrail:
    """
    Enforces strict category matching to prevent apparel/RTW items from auto-matching bag requests when sold out.
    """
    @staticmethod
    def validate_request_match(request_category: str, candidate_category: str) -> bool:
        if not request_category or not candidate_category:
            return False
        return request_category.strip().lower() == candidate_category.strip().lower()

    @staticmethod
    def handle_sold_out(request_id: str, client_name: str, requested_item: str) -> Dict[str, Any]:
        return {
            "request_id": request_id,
            "client_name": client_name,
            "requested_item": requested_item,
            "status": "sold_out",
            "allow_fallback_to_other_categories": False,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
