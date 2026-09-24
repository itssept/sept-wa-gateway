import json
import asyncio
from executor import aio, executor, Chat, UserPrompt, TextContent, ImageContent

LUXURY_EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string", "description": "Luxury house/brand name, e.g., Hermès, Chanel, Bottega Veneta, Goyard"},
        "model": {"type": "string", "description": "Specific model name or silhouette / collection name as stated by sourcer or verified catalog"},
        "category": {"type": "string", "description": "Product category: Bags, Shoes, Ready-to-Wear, Jewelry, Watches, Accessories"},
        "size": {"type": "string", "description": "Dimension in cm or size stated/converted, e.g., 25, 28, FR 36 / US 4, EU 38"},
        "colour": {"type": "string", "description": "Colour name, e.g., Noir, Gold, Etoupe, Parakeet, Craie, Port/Burgundy"},
        "material": {"type": "string", "description": "Specific leather/fabric/texture, e.g., Togo, Epsom, Clemence, Caviar, Lambskin, Flat crystal strass"},
        "hardware": {"type": "string", "description": "Hardware specification: GHW, PHW, SHW, RHW, BGHW, BPHW, Ruthenium, or 'ambiguous (lighting)'"},
        "condition": {"type": "string", "description": "Condition grade: BNIB, Store Fresh, Pristine, Excellent, Very Good, Good, Vintage, or Unknown"},
        "completeness": {
            "type": "object",
            "properties": {
                "box": {"type": "boolean"},
                "dust_bag": {"type": "boolean"},
                "receipt": {"type": "boolean"},
                "authenticity_card": {"type": "boolean"},
                "tags": {"type": "boolean"},
                "full_set": {"type": "boolean"}
            }
        },
        "pricing": {
            "type": "object",
            "properties": {
                "amount": {"type": ["number", "null"]},
                "currency": {"type": ["string", "null"]},
                "price_type": {"type": "string", "enum": ["asking", "offered", "quoted", "paid", "pending_quote"]}
            },
            "required": ["amount", "currency", "price_type"]
        },
        "source_metadata": {
            "type": "object",
            "properties": {
                "sourcer_handle_or_name": {"type": ["string", "null"]},
                "channel": {"type": "string", "enum": ["whatsapp", "instagram", "other"]},
                "location": {"type": ["string", "null"]},
                "shipping_feasibility": {"type": ["string", "null"]}
            }
        },
        "provenance": {
            "type": "string",
            "enum": ["stated_by_operator", "stated_by_sourcer", "observed_in_chat", "estimated_by_agent"]
        },
        "visual_conflict": {
            "type": "object",
            "properties": {
                "has_conflict": {"type": "boolean", "description": "Whether bot's visual guess conflicts with sourcer/operator stated identification"},
                "bot_visual_guess": {"type": ["string", "null"], "description": "What the bot's ungrounded visual reading might have guessed"},
                "sourcer_stated_id": {"type": ["string", "null"], "description": "The sourcer's explicit identification which strictly wins"},
                "resolution_notes": {"type": "string", "description": "Explanation noting the visual conflict while strictly deferring to the sourcer"}
            },
            "required": ["has_conflict", "resolution_notes"]
        },
        "ambiguity_notes": {"type": "string", "description": "Any ambiguous lighting, unconfirmed condition, or unlisted status notes"}
    },
    "required": [
        "brand",
        "model",
        "category",
        "colour",
        "material",
        "hardware",
        "condition",
        "completeness",
        "pricing",
        "provenance"
    ]
}

SYSTEM_PROMPT = """You are SEPT's luxury parser and vision extraction engine.
Extract structured luxury attributes from inbound supplier forwards, chat screenshots, or images.

Core Invariants for Item Identification & Grounding:
1. SOURCER ATTRIBUTION WINS OVER VISUAL GUESS:
   - When a sourcer (or operator) explicitly states or names a piece, collection, season, or provenance (e.g. 'Pre-Fall 2013 Paris-Edinburgh Collection'), the sourcer's stated identification STRICTLY WINS over any visual guess (e.g. 'Byzance').
   - Set `provenance` to `stated_by_sourcer`.
   - Never override or contradict explicit sourcer attribution with speculative visual inferences or fabricated lore.
   - If the visual features could suggest a different collection, note the conflict in `visual_conflict` (e.g. noting the visual guess and explaining why the sourcer's identification wins), but the canonical `model` and item description MUST defer to the sourcer.

2. Luxury Trade Conventions:
   - Hardware: GHW (Gold), PHW (Palladium), SHW (Silver), RHW (Rose Gold), BGHW (Brushed Gold), BPHW (Brushed Palladium). If lighting makes plating unclear, mark hardware as 'ambiguous (lighting)'.
   - Leathers & Materials: Togo, Epsom, Clemence, Swift, Box, Chevre, Caviar, Lambskin, Croc, Ostrich. Distinguish flat crystal strass from 3D raised appliqués.
   - Sizes: Extract dimensions in cm (e.g. K28 -> Kelly 28cm, B25 -> Birkin 25cm).
   - Conditions: BNIB (Brand New In Box), Store Fresh, Full Set (FS), Pristine, Excellent, Very Good, Good, Vintage. If not stated, mark as 'Unknown'.
   - Provenance: Mark 'stated_by_sourcer' if stated by sourcer, 'stated_by_operator' if operator stated, 'observed_in_chat' if extracted from chat, or 'estimated_by_agent' if inferred.
   - Never invent retail SKUs, authenticity guarantees, or non-existent provenance.
"""

async def parse_luxury_input(text_context: str, image_bytes: bytes = None, image_mime_type: str = "image/jpeg"):
    prompt_text = f"Analyze and extract the luxury item specification from this input:\n\n{text_context}"
    
    if image_bytes:
        user_prompt = UserPrompt(content_blocks=[
            TextContent(text=prompt_text),
            ImageContent(media_type=image_mime_type, data=image_bytes)
        ])
    else:
        user_prompt = UserPrompt.from_text(prompt_text)
    
    chat = Chat.from_prompt(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=user_prompt
    )
    
    extracted_data = await aio.call_llm(chat, output_schema=LUXURY_EXTRACTION_SCHEMA)
    return extracted_data

async def main():
    executor.print("Starting Luxury Item Extraction Tests...\n")
    
    test_cases = [
        {
            "name": "Case 1: Sourcer Overrides Visual (Les Intemporels Paris-Edinburgh vs Byzance)",
            "context": "Forwarded from @les_intemporels_paris: 'Photo attached of vintage Chanel burgundy quilted shoulder bag with Byzantine-style chainmail tassel and ruthenium plaque. Bag is from Pre Fall 2013, Paris-Edinburgh Collection. Price will follow.'"
        },
        {
            "name": "Case 2: Standard Hermès Supply Ingestion",
            "context": "Forwarded from @edp_luxury: 'Hermès Kelly 28 Gold Togo GHW, Store Fresh, Full Set with receipt dated last week. Asking 18,500 EUR.'"
        },
        {
            "name": "Case 3: Multilingual Mixed Ready-to-Wear Forward",
            "context": "Forwarded from @luxe_milan: 'Hermès RTW silk twill jacket, FR 38 / IT 42, jamais porté (pristine/unworn). No box, only dust cover. 2,400 CHF.'"
        }
    ]
    
    results = []
    for tc in test_cases:
        executor.print(f"--- Running {tc['name']} ---")
        result = await parse_luxury_input(tc["context"])
        results.append({"test_case": tc["name"], "result": result})
        executor.print(json.dumps(result, indent=2))
        executor.print("\n" + "="*50 + "\n")
        
    await aio.store_artifact(
        identifier="luxury_extraction_test_results",
        title="Luxury Extraction Test Results",
        artifact_type="text",
        data=json.dumps(results, indent=2),
        metadata={"text": {"content_type": "text/markdown"}}
    )
    executor.print("Successfully completed test run and saved artifact 'luxury_extraction_test_results'.")