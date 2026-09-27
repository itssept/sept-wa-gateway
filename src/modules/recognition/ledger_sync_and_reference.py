import json
import hashlib
import re
from datetime import datetime, timezone, timedelta
from executor import aio, executor
from sourcer_entity_resolver import sourcer_resolver, sanitize_handle_for_classification

# Reference culture ground truth mapping
REFERENCE_CULTURE_REGISTRY = [
    {
        "alias": "the green one hailey had",
        "keywords": ["hailey", "green"],
        "resolved_spec": {
            "brand": "Bottega Veneta",
            "model": "Jodie",
            "size": "Teen / Small",
            "colour": "Parakeet",
            "material": "Intrecciato Lambskin",
            "hardware": "Gold Tone",
            "category": "Bags"
        },
        "notes": "Hailey Bieber street style; resolves to Bottega Veneta Jodie in Parakeet green."
    },
    {
        "alias": "the jlo birkin",
        "keywords": ["jlo", "birkin", "ostrich"],
        "resolved_spec": {
            "brand": "Hermès",
            "model": "Birkin 35",
            "size": "35",
            "colour": "Cognac / Tan",
            "material": "Ostrich",
            "hardware": "GHW",
            "category": "Bags"
        },
        "notes": "Jennifer Lopez street style Hermès Birkin 35 in cognac ostrich with gold hardware."
    },
    {
        "alias": "kendall jenner cipriani london look",
        "keywords": ["kendall", "cipriani", "london", "row"],
        "resolved_spec": {
            "brand": "The Row",
            "model": "Half Moon Flap Bag",
            "size": "Small",
            "colour": "Bordeaux / Deep Burgundy",
            "material": "Smooth Calfskin",
            "hardware": "Minimal / Tonal",
            "category": "Bags"
        },
        "notes": "Kendall Jenner London Cipriani look; smooth unquilted calfskin flap in bordeaux/burgundy."
    }
]

def resolve_reference_culture(text_query: str) -> dict:
    query_norm = text_query.lower()
    for entry in REFERENCE_CULTURE_REGISTRY:
        matches = [kw for kw in entry["keywords"] if kw in query_norm]
        if len(matches) >= 2 or entry["alias"] in query_norm:
            return {
                "matched": True,
                "reference_alias": entry["alias"],
                "resolved_spec": entry["resolved_spec"],
                "notes": entry["notes"]
            }
    return {"matched": False, "reference_alias": None, "resolved_spec": None}

def normalize_text(text: str) -> str:
    if not text:
        return ""
    # Strip punctuation, lowercase, collapse whitespace
    cleaned = re.sub(r"[^\w\s]", "", str(text).lower())
    return " ".join(cleaned.split())

from item_identity_resolver import item_identity_resolver

def generate_canonical_item_id(parsed_item: dict) -> str:
    """
    Generates a deterministic SHA-256 fingerprint for a luxury item based on invariant attributes and Rule 41.
    Guarantees: The same piece from the same sourcer gets the EXACT SAME item ID
    across different WhatsApp / Instagram chats, whether forwarded 1 minute or 1 month apart.
    """
    source_meta = parsed_item.get("source_metadata", {})
    return item_identity_resolver.generate_canonical_piece_id(
        resolved_item=parsed_item,
        sourcer_meta=source_meta,
        image_phash=parsed_item.get("perceptual_hash") or parsed_item.get("image_phash")
    )

class OperatorLedger:
    def __init__(self, operator_id: str):
        self.operator_id = operator_id
        self.inventory = []
        self.sourcers = {}
        self.inventory_by_id = {}
        self.resolver = sourcer_resolver
        
    def ingest_parsed_item(self, parsed_item: dict):
        # Deterministic cross-chat item ID
        item_id = generate_canonical_item_id(parsed_item)
        now = datetime.now(timezone.utc)
        
        # 1. Update sourcer strictly via DB resolution (Anti-Name Association)
        source_meta = parsed_item.get("source_metadata", {})
        raw_handle = source_meta.get("sourcer_handle_or_name") or "unknown_source"
        phone = source_meta.get("phone")
        
        sourcer_db_rec = self.resolver.resolve_sourcer_by_id_or_handle(raw_handle, phone=phone)
        sourcer_id = sourcer_db_rec["sourcer_id"]
        
        if sourcer_id not in self.sourcers:
            self.sourcers[sourcer_id] = {
                "sourcer_id": sourcer_id,
                "canonical_name": sourcer_db_rec["canonical_name"],
                "name_or_handle": raw_handle,
                "channel": source_meta.get("channel", "whatsapp"),
                "base_country_code": sourcer_db_rec["base_country_code"],
                "base_country_name": sourcer_db_rec["base_country_name"],
                "base_city": sourcer_db_rec["base_city"],
                "specialties": sourcer_db_rec["specialties"],
                "verified_locations": sourcer_db_rec["verified_locations"],
                "in_store_runners": sourcer_db_rec["in_store_runners"],
                "verified_boutiques": sourcer_db_rec["verified_boutiques"],
                "items_logged_count": 0,
                "first_seen": now.isoformat(),
                "last_seen": now.isoformat()
            }
        
        self.sourcers[sourcer_id]["items_logged_count"] += 1
        self.sourcers[sourcer_id]["last_seen"] = now.isoformat()
        
        # 2. Check for deduplication / update
        price_info = parsed_item.get("pricing", {})
        price_val = price_info.get("amount")
        currency = price_info.get("currency", "USD")
        
        if item_id in self.inventory_by_id:
            existing_item = self.inventory_by_id[item_id]
            # Refresh price or condition if updated
            if price_val and existing_item["price"] != price_val:
                existing_item["price"] = price_val
                existing_item["price_history"].append({"price": price_val, "timestamp": now.isoformat()})
            existing_item["last_seen_at"] = now.isoformat()
            existing_item["frequency_count"] += 1
            return existing_item
            
        # 3. New Item Ingestion
        item_entry = {
            "item_id": item_id,
            "brand": parsed_item.get("brand"),
            "model": parsed_item.get("model"),
            "category": parsed_item.get("category", "Bags"),
            "size": parsed_item.get("size"),
            "colour": parsed_item.get("colour"),
            "material": parsed_item.get("material"),
            "hardware": parsed_item.get("hardware"),
            "condition": parsed_item.get("condition", "Unknown"),
            "completeness": parsed_item.get("completeness", {}),
            "price": price_val,
            "currency": currency,
            "price_type": price_info.get("price_type", "firm"),
            "sourcer": sourcer_db_rec["canonical_name"],
            "sourcer_id": sourcer_id,
            "base_country_code": sourcer_db_rec["base_country_code"],
            "verified_locations": sourcer_db_rec["verified_locations"],
            "channel": source_meta.get("channel", "whatsapp"),
            "provenance": parsed_item.get("provenance", "stated_by_sourcer"),
            "visual_conflict": parsed_item.get("visual_conflict", {}),
            "first_seen_at": now.isoformat(),
            "last_seen_at": now.isoformat(),
            "frequency_count": 1,
            "price_history": [{"price": price_val, "timestamp": now.isoformat()}] if price_val else []
        }
        
        self.inventory.append(item_entry)
        self.inventory_by_id[item_id] = item_entry
        return item_entry

async def main():
    executor.print("Testing Ledger Sync, Reference Culture Mapping & Invariant Deduplication...\n")
    
    # 1. Test Reference Culture Resolution
    ref_query_1 = "Client wants the green one hailey had recently"
    ref_res_1 = resolve_reference_culture(ref_query_1)
    executor.print(f"Reference Query: '{ref_query_1}'")
    executor.print(f"-> Resolved: {json.dumps(ref_res_1, indent=2)}\n")
    
    ref_query_2 = "Can you source the kendall jenner london cipriani bag?"
    ref_res_2 = resolve_reference_culture(ref_query_2)
    executor.print(f"Reference Query: '{ref_query_2}'")
    executor.print(f"-> Resolved: {json.dumps(ref_res_2, indent=2)}\n")
    
    # 2. Test Ingestion with Anti-Name Association
    ledger = OperatorLedger(operator_id="op_yara_aldhaen")
    
    sample_parsed_items = [
        {
            "brand": "Chanel",
            "model": "Pre-Fall 2013 Paris-Edinburgh Burgundy Tassel Bag",
            "category": "Bags",
            "size": "Medium / 25cm",
            "colour": "Burgundy",
            "material": "Quilted Calfskin",
            "hardware": "Ruthenium",
            "condition": "Vintage / Excellent",
            "completeness": {"full_set": False},
            "pricing": {"amount": None, "currency": "USD", "price_type": "pending_quote"},
            "source_metadata": {"sourcer_handle_or_name": "@les_intemporels_paris", "phone": "+961 81 324 102", "channel": "whatsapp"},
            "provenance": "stated_by_sourcer",
            "visual_conflict": {
                "has_conflict": True,
                "bot_visual_guess": "Paris-Byzance Pre-Fall 2011",
                "sourcer_stated_id": "Pre Fall 2013, Paris-Edinburgh Collection",
                "resolution_notes": "Visual tassel features could resemble Byzance, but sourcer Les Intemporels Paris explicitly confirmed Paris-Edinburgh 2013. Deferring strictly to sourcer attribution."
            }
        },
        {
            "brand": "Hermès",
            "model": "Kelly 28",
            "category": "Bags",
            "size": "28",
            "colour": "Noir",
            "material": "Togo",
            "hardware": "GHW",
            "condition": "Store Fresh",
            "completeness": {"full_set": True, "box": True, "receipt": True},
            "pricing": {"amount": 22500, "currency": "EUR", "price_type": "firm"},
            "source_metadata": {"sourcer_handle_or_name": "@edp_luxury", "channel": "whatsapp"},
            "provenance": "stated_by_sourcer"
        },
        {
            "brand": "Chanel",
            "model": "Pre-Fall 2013 Paris-Edinburgh Burgundy Tassel Bag",
            "category": "Bags",
            "size": "Medium / 25cm",
            "colour": "Burgundy",
            "material": "Quilted Calfskin",
            "hardware": "Ruthenium",
            "condition": "Vintage / Excellent",
            "completeness": {"full_set": False},
            "pricing": {"amount": 7800, "currency": "USD", "price_type": "firm"},
            "source_metadata": {"sourcer_handle_or_name": "@les_intemporels_paris", "phone": "+961 81 324 102", "channel": "whatsapp"},
            "provenance": "observed_in_chat"
        }
    ]
    
    for item in sample_parsed_items:
        ingested = ledger.ingest_parsed_item(item)
        executor.print(f"Logged Inventory ID [{ingested['item_id']}]: {ingested['brand']} {ingested['model']} from {ingested['sourcer']} ({ingested['currency']} {ingested['price']}) - Base Country: {ingested['base_country_code']}")
        
    executor.print("\n=== Active Sourcers Book ===")
    executor.print(json.dumps(ledger.sourcers, indent=2))
    
    # Store artifacts
    await aio.store_artifact(
        identifier="operator_inventory_ledger",
        title="Operator Private Inventory Ledger",
        artifact_type="table",
        data=ledger.inventory
    )
    
    sourcer_rows = list(ledger.sourcers.values())
    await aio.store_artifact(
        identifier="operator_sourcers_ledger",
        title="Operator Sourcers Book",
        artifact_type="table",
        data=sourcer_rows
    )
    
    executor.print("\nSuccessfully updated operator ledger and stored table artifacts.")