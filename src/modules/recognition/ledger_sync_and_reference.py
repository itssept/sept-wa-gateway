import json
import uuid
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
        "notes": "Jennifer Lopez gym street style; Birkin 35 Ostrich."
    },
    {
        "alias": "kendall jenner cipriani london look / burgundy bag",
        "keywords": ["kendall", "cipriani", "burgundy", "unquilted"],
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
        "notes": "Ambiguous reference. Sourcing rules require explicit operator clarification instead of speculative guessing."
    }

class OperatorLedger:
    def __init__(self, operator_id: str):
        self.operator_id = operator_id
        self.inventory = []
        self.sourcers = {}
        
    def ingest_parsed_item(self, parsed_item: dict):
        item_id = str(uuid.uuid4())[:8]
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
        
        # 2. Ingest inventory record
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
            "lifecycle_status": "available",
            "provenance": parsed_item.get("provenance", "observed_in_chat"),
            "ambiguity_notes": parsed_item.get("ambiguity_notes", "")
        }
        self.inventory.append(inv_record)
        return inv_record

async def main():
    executor.print("Testing Step 2: Reference Culture Resolution & Ledger Ingestion...\n")
    
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
        },
        {
            "brand": "Bottega Veneta",
            "model": "Jodie",
            "category": "Bags",
            "size": "Teen / Small",
            "colour": "Parakeet",
            "material": "Intrecciato Lambskin",
            "hardware": "Gold Tone",
            "condition": "Store Fresh",
            "completeness": {"full_set": True},
            "pricing": {"amount": 2800, "currency": "EUR", "price_type": "asking"},
            "source_metadata": {"sourcer_handle_or_name": "@edp_luxury", "channel": "whatsapp", "location": "Milan"},
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