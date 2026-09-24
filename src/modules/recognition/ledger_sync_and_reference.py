import json
import hashlib
import re
from datetime import datetime, timezone, timedelta
from executor import aio, executor

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
        "notes": "Jennifer Lopez archival Hermès Birkin 35 in Ostrich leather with gold hardware."
    },
    {
        "alias": "kendall jenner cipriani london look",
        "keywords": ["kendall", "cipriani", "burgundy"],
        "resolved_spec": {
            "brand": "Chanel",
            "model": "Pre-Fall Métiers d'Art Soft Unquilted Flap",
            "size": "Medium",
            "colour": "Burgundy / Port",
            "material": "Smooth Calfskin",
            "hardware": "BGHW / Gold Tone",
            "category": "Bags"
        },
        "notes": "Kendall Jenner London Cipriani look; smooth unquilted calfskin flap in bordeaux/burgundy."
    }
]

def resolve_reference_culture(query: str):
    q_norm = query.lower().strip()
    
    # Exact or keyword fuzzy match
    for ref in REFERENCE_CULTURE_REGISTRY:
        if ref["alias"] in q_norm or all(k in q_norm for k in ref["keywords"]):
            return {
                "resolved": True,
                "confidence": "high",
                "resolved_spec": ref["resolved_spec"],
                "notes": ref["notes"]
            }
            
    return {
        "resolved": False,
        "confidence": "low",
        "notes": "Ambiguous reference. Sourcing rules require explicit operator clarification."
    }

def normalize_text(text: str) -> str:
    if not text:
        return ""
    # Lowercase, strip non-alphanumeric except spaces
    cleaned = re.sub(r'[^a-zA-Z0-9\s]', '', str(text).lower())
    return " ".join(cleaned.split())

def generate_canonical_item_id(parsed_item: dict) -> str:
    """
    Generates a deterministic canonical item ID across chats and threads based on
    core item characteristics and source identity.
    
    Guarantees: The same piece from the same sourcer gets the EXACT SAME item ID
    across different chats, preventing ID fragmentation.
    """
    brand = normalize_text(parsed_item.get("brand", ""))
    model = normalize_text(parsed_item.get("model", ""))
    size = normalize_text(parsed_item.get("size", ""))
    colour = normalize_text(parsed_item.get("colour", ""))
    material = normalize_text(parsed_item.get("material", ""))
    hardware = normalize_text(parsed_item.get("hardware", ""))
    
    source_meta = parsed_item.get("source_metadata", {})
    sourcer = normalize_text(source_meta.get("sourcer_handle_or_name", ""))
    
    # Core fingerprint string
    fingerprint = f"{brand}|{model}|{size}|{colour}|{material}|{hardware}|{sourcer}"
    hash_digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:10]
    
    brand_prefix = (brand[:3] if brand else "itm").upper()
    return f"{brand_prefix}_{hash_digest}"

class OperatorLedger:
    def __init__(self, operator_id: str):
        self.operator_id = operator_id
        self.inventory = []
        self.sourcers = {}
        self.inventory_by_id = {}
        
    def ingest_parsed_item(self, parsed_item: dict):
        # Deterministic cross-chat item ID
        item_id = generate_canonical_item_id(parsed_item)
        now = datetime.now(timezone.utc)
        
        # 1. Update sourcer stub if present
        source_meta = parsed_item.get("source_metadata", {})
        sourcer_handle = source_meta.get("sourcer_handle_or_name") or "unknown_source"
        
        if sourcer_handle not in self.sourcers:
            self.sourcers[sourcer_handle] = {
                "sourcer_id": f"src_{len(self.sourcers) + 1}",
                "name_or_handle": sourcer_handle,
                "channel": source_meta.get("channel", "whatsapp"),
                "location": source_meta.get("location"),
                "items_logged_count": 0,
                "first_seen": now.isoformat()
            }
        self.sourcers[sourcer_handle]["items_logged_count"] += 1
        
        # 2. Check if item already exists in ledger (deduplication / update)
        if item_id in self.inventory_by_id:
            existing = self.inventory_by_id[item_id]
            # Update price/provenance if newer or if price arrived
            new_price = parsed_item.get("pricing", {}).get("amount")
            if new_price is not None:
                existing["price"] = new_price
                existing["currency"] = parsed_item.get("pricing", {}).get("currency")
                existing["price_type"] = parsed_item.get("pricing", {}).get("price_type", "asking")
            existing["last_seen"] = now.isoformat()
            return existing
        
        # Ingest new inventory record
        inv_record = {
            "item_id": item_id,
            "brand": parsed_item.get("brand"),
            "model": parsed_item.get("model"),
            "category": parsed_item.get("category"),
            "size": parsed_item.get("size"),
            "colour": parsed_item.get("colour"),
            "material": parsed_item.get("material"),
            "hardware": parsed_item.get("hardware"),
            "condition": parsed_item.get("condition"),
            "completeness": "Full Set" if parsed_item.get("completeness", {}).get("full_set") else "Partial / Incomplete",
            "price": parsed_item.get("pricing", {}).get("amount"),
            "currency": parsed_item.get("pricing", {}).get("currency"),
            "price_type": parsed_item.get("pricing", {}).get("price_type", "asking"),
            "sourcer": sourcer_handle,
            "location": source_meta.get("location") or "Unspecified",
            "date_logged": now.isoformat(),
            "last_seen": now.isoformat(),
            "lifecycle_status": "available",
            "provenance": parsed_item.get("provenance", "observed_in_chat"),
            "visual_conflict": parsed_item.get("visual_conflict", {}),
            "ambiguity_notes": parsed_item.get("ambiguity_notes", "")
        }
        
        self.inventory.append(inv_record)
        self.inventory_by_id[item_id] = inv_record
        return inv_record

async def main():
    executor.print("Starting Reference Culture & Ledger Ingestion...\n")
    
    # 1. Reference Culture Tests
    queries = [
        "Do we have the green one Hailey had?",
        "Client looking for the Kendall Jenner Cipriani burgundy bag",
        "Looking for that vintage jacket she wore yesterday"
    ]
    
    executor.print("=== 1. Reference Culture Resolution Tests ===")
    ref_results = []
    for q in queries:
        res = resolve_reference_culture(q)
        ref_results.append({"query": q, "resolution": res})
        executor.print(f"Query: '{q}'")
        executor.print(f"Result: {json.dumps(res, indent=2)}\n")
        
    # 2. Ledger Ingestion Tests
    executor.print("=== 2. Operator Ledger Ingestion Tests ===")
    ledger = OperatorLedger(operator_id="operator_joanna_luxe")
    
    # Ingesting the items parsed from Step 1
    sample_parsed_items = [
        {
            "brand": "Chanel",
            "model": "Pre-Fall 2013 Paris-Edinburgh Burgundy Tassel Bag",
            "category": "Bags",
            "size": "Medium",
            "colour": "Burgundy",
            "material": "Quilted Calfskin",
            "hardware": "Ruthenium",
            "condition": "Vintage / Excellent",
            "completeness": {"full_set": False},
            "pricing": {"amount": None, "currency": "USD", "price_type": "pending_quote"},
            "source_metadata": {"sourcer_handle_or_name": "@les_intemporels_paris", "channel": "whatsapp", "location": "Paris"},
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
            "colour": "Gold",
            "material": "Togo",
            "hardware": "GHW",
            "condition": "Store Fresh",
            "completeness": {"full_set": True},
            "pricing": {"amount": 18500, "currency": "EUR", "price_type": "asking"},
            "source_metadata": {"sourcer_handle_or_name": "@edp_luxury", "channel": "whatsapp", "location": "Paris"},
            "provenance": "observed_in_chat"
        },
        {
            "brand": "Chanel",
            "model": "Classic Flap Medium",
            "category": "Bags",
            "size": "Medium / Large (25.5 cm)",
            "colour": "Black",
            "material": "Caviar",
            "hardware": "ambiguous (lighting)",
            "condition": "BNIB",
            "completeness": {"full_set": False},
            "pricing": {"amount": 8200, "currency": "GBP", "price_type": "quoted"},
            "source_metadata": {"sourcer_handle_or_name": "VIP Sourcing Chat", "channel": "whatsapp", "location": "London"},
            "provenance": "observed_in_chat"
        }
    ]
    
    for item in sample_parsed_items:
        ingested = ledger.ingest_parsed_item(item)
        executor.print(f"Logged Inventory ID [{ingested['item_id']}]: {ingested['brand']} {ingested['model']} from {ingested['sourcer']} ({ingested['currency']} {ingested['price']})")
        
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