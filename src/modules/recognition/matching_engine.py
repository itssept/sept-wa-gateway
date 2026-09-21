import json
import uuid
from datetime import datetime, timezone
from executor import aio, executor

class SEPTMatchingEngine:
    def __init__(self, operator_ledger_inventory: list):
        self.inventory = operator_ledger_inventory
        self.open_requests = []
        self.matches_found = []
        
    def add_client_request(self, client_name: str, client_phone: str, brand: str, model: str, size: str = None, 
                           colour: str = None, hardware: str = None, max_budget: float = None, currency: str = "EUR", notes: str = ""):
        req_id = f"req_{len(self.open_requests) + 1}_{str(uuid.uuid4())[:6]}"
        request_obj = {
            "request_id": req_id,
            "client_name": client_name,
            "client_phone": client_phone,
            "brand": brand,
            "model": model,
            "size": size,
            "colour": colour,
            "hardware": hardware,
            "max_budget": max_budget,
            "currency": currency,
            "date_opened": datetime.now(timezone.utc).strftime("%d %b %Y"),
            "status": "open",
            "notes": notes
        }
        self.open_requests.append(request_obj)
        return request_obj

    def score_match(self, request: dict, item: dict):
        # 1. Brand match is strict requirement
        if request["brand"].lower() not in item["brand"].lower() and item["brand"].lower() not in request["brand"].lower():
            return 0.0, []
        
        # 2. Model match is strict requirement
        if request["model"].lower() not in item["model"].lower() and item["model"].lower() not in request["model"].lower():
            return 0.0, []
            
        score = 0.5  # Base match for brand + model
        reasons = [f"Matched brand '{request['brand']}' and model '{request['model']}'"]
        
        # 3. Size evaluation
        if request.get("size") and item.get("size"):
            if str(request["size"]).lower() in str(item["size"]).lower() or str(item["size"]).lower() in str(request["size"]).lower():
                score += 0.2
                reasons.append(f"Matched size '{item['size']}'")
            else:
                return 0.0, ["Size mismatch"]
                
        # 4. Colour evaluation
        if request.get("colour") and item.get("colour"):
            if request["colour"].lower() in item["colour"].lower() or item["colour"].lower() in request["colour"].lower():
                score += 0.15
                reasons.append(f"Matched colour '{item['colour']}'")
            else:
                score -= 0.1
                
        # 5. Hardware evaluation
        if request.get("hardware") and item.get("hardware"):
            if request["hardware"].lower() in item["hardware"].lower() or item["hardware"].lower() in request["hardware"].lower():
                score += 0.15
                reasons.append(f"Matched hardware '{item['hardware']}'")
            elif "ambiguous" in item["hardware"].lower():
                score += 0.05
                reasons.append("Hardware ambiguous in source photo (needs operator confirmation)")
                
        return min(score, 1.0), reasons

    def run_matching(self):
        self.matches_found = []
        for req in self.open_requests:
            if req["status"] != "open":
                continue
            for item in self.inventory:
                if item.get("lifecycle_status") != "available":
                    continue
                score, reasons = self.score_match(req, item)
                if score >= 0.7:
                    alert_text = self.format_operator_alert(req, item, score)
                    match_record = {
                        "match_id": str(uuid.uuid4())[:8],
                        "request_id": req["request_id"],
                        "client_name": req["client_name"],
                        "item_id": item["item_id"],
                        "item_desc": f"{item['brand']} {item['model']} ({item['colour']}, {item['hardware']})",
                        "sourcer": item["sourcer"],
                        "cost_price": f"{item['currency']} {item['price']}",
                        "match_score": round(score, 2),
                        "operator_alert": alert_text,
                        "status": "pending_operator_review"
                    }
                    self.matches_found.append(match_record)
        return self.matches_found

    def format_operator_alert(self, req: dict, item: dict, score: float):
        # Strict SEPT operator alert format:
        # [Client Name] asked for [Item] on [Date]. [Item] surfaced from [Sourcer] at [Price]. Reply SEND to draft.
        return (
            f"⚡ MATCH ALERT: {req['client_name']} asked for {req['brand']} {req['model']} on {req['date_opened']}. "
            f"{item['brand']} {item['model']} ({item['colour']}, {item['material']}, {item['hardware']}) "
            f"surfaced from {item['sourcer']} at {item['currency']} {item['price']:,.0f}. "
            f"Reply SEND to draft."
        )

async def main():
    executor.print("Testing Step 3: Decoupled Matching Engine & Operator Alerts...\n")
    
    # Retrieve inventory from Step 2 artifact or fallback
    inv_artifact = await aio.get_artifact("operator_inventory_ledger")
    inventory = inv_artifact if isinstance(inv_artifact, list) else (inv_artifact.get("data", []) if isinstance(inv_artifact, dict) else [])
    
    if not inventory:
        executor.print("No inventory found, initializing test items...")
        inventory = [
            {
                "item_id": "655ea7fd",
                "brand": "Hermès",
                "model": "Kelly 28",
                "size": "28",
                "colour": "Gold",
                "material": "Togo",
                "hardware": "GHW",
                "condition": "Store Fresh",
                "price": 18500,
                "currency": "EUR",
                "sourcer": "@edp_luxury",
                "lifecycle_status": "available"
            },
            {
                "item_id": "6c7a14c2",
                "brand": "Bottega Veneta",
                "model": "Jodie",
                "size": "Teen / Small",
                "colour": "Parakeet",
                "material": "Intrecciato Lambskin",
                "hardware": "Gold Tone",
                "condition": "Store Fresh",
                "price": 2800,
                "currency": "EUR",
                "sourcer": "@edp_luxury",
                "lifecycle_status": "available"
            }
        ]

    engine = SEPTMatchingEngine(inventory)
    
    # Add active VIP Client Requests
    engine.add_client_request(
        client_name="Sara Al-Sabah",
        client_phone="+96590001122",
        brand="Hermès",
        model="Kelly 28",
        size="28",
        colour="Gold",
        hardware="GHW",
        max_budget=22000,
        currency="EUR",
        notes="Looking for store fresh Kelly 28 Gold on Gold for wedding season"
    )
    
    engine.add_client_request(
        client_name="Noura Al-Ghanim",
        client_phone="+971501122334",
        brand="Bottega Veneta",
        model="Jodie",
        size="Teen / Small",
        colour="Parakeet",
        max_budget=3500,
        currency="EUR",
        notes="Wants the Hailey Bieber green Jodie bag"
    )
    
    engine.add_client_request(
        client_name="Yasmin Mansour",
        client_phone="+447700900123",
        brand="Chanel",
        model="Kelly Nano",
        notes="Only looking for rare pink Nano Kelly"
    )
    
    executor.print(f"Loaded {len(engine.open_requests)} active client requests.")
    
    # Execute matching
    matches = engine.run_matching()
    executor.print(f"\nDiscovered {len(matches)} high-confidence matches:\n")
    
    for m in matches:
        executor.print(f"--- Match ID: {m['match_id']} (Score: {m['match_score']}) ---")
        executor.print(f"Client: {m['client_name']}")
        executor.print(f"Item: {m['item_desc']}")
        executor.print(f"Cost: {m['cost_price']} from {m['sourcer']}")
        executor.print(f"Operator Alert Preview:\n>> {m['operator_alert']}\n")
        
    await aio.store_artifact(
        identifier="sept_active_matches",
        title="SEPT Active Inventory Matches & Alerts",
        artifact_type="table",
        data=matches
    )
    
    await aio.store_artifact(
        identifier="sept_open_requests",
        title="SEPT Open Client Requests",
        artifact_type="table",
        data=engine.open_requests
    )
    
    executor.print("Stored artifacts 'sept_active_matches' and 'sept_open_requests'.")