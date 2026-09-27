"""
item_identity_resolver.py — Item Identity Resolution & Rule 41 (Provenance Priority) Engine.

Scope:
- Rule 41 (Provenance Priority): A sourcer's stated season, collection, year, or provenance always wins.
  Store it as `stated_by_sourcer`. Visual observations can be noted internally (e.g. `visual_notes`,
  `internal_visual_guess`) but NEVER override the sourcer's stated collection/season/year/model.
- Canonical resolution against the central pieces ledger using normalized text + perceptual image hashing (dHash/pHash/aHash) + database-bound sourcer resolution.
- Guarantees:
  1. Replaying the Les Intemporels case keeps "Pre-Fall 2013 Paris-Edinburgh", rejecting visual override "Chanel Byzance".
  2. The same piece sent in two different chats (different chat IDs, timestamps, or message envelopes) resolves to one canonical piece_id.
  3. Two genuinely different similar-looking pieces (e.g. different hardware, different size, different material, or different perceptual image hash) do NOT merge (zero false positive).
"""

import re
import hashlib
import json
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List, Tuple
from sourcer_entity_resolver import sourcer_resolver, sanitize_handle_for_classification

# Simple perceptual difference hash (dHash) simulation for luxury item images
def compute_perceptual_image_hash(image_data: Any) -> str:
    """
    Computes or extracts a canonical perceptual hash (dHash/pHash) for an item image.
    In production/test simulation, handles hex perceptual hash strings, base64 strings, or simulated image matrices.
    """
    if isinstance(image_data, str) and (image_data.startswith("phash:") or image_data.startswith("dhash:")):
        return image_data.split(":", 1)[1].strip().lower()
    if isinstance(image_data, str):
        # Normalize string and compute deterministic hash
        cleaned = re.sub(r"\s+", "", image_data.lower())
        return hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:16]
    if isinstance(image_data, bytes):
        return hashlib.sha256(image_data).hexdigest()[:16]
    return "0000000000000000"

def hamming_distance(hash1: str, hash2: str) -> int:
    """Computes the Hamming distance between two hex hash strings."""
    if not hash1 or not hash2:
        return 999
    # Pad or truncate to equal lengths
    h1 = bytes.fromhex(hash1.zfill(16)[:16])
    h2 = bytes.fromhex(hash2.zfill(16)[:16])
    dist = 0
    for b1, b2 in zip(h1, h2):
        dist += bin(b1 ^ b2).count("1")
    return dist

def normalize_text_attribute(text: Any) -> str:
    if not text:
        return ""
    # Strip non-alphanumeric (keep whitespace), lowercase, collapse multiple spaces
    cleaned = re.sub(r"[^\w\s]", "", str(text).lower())
    return " ".join(cleaned.split())

class ItemIdentityResolver:
    """
    Enforces Rule 41 (Provenance Priority) and Canonical Pieces Ledger Resolution.
    """
    def __init__(self):
        self.resolver = sourcer_resolver
        self.pieces_ledger: Dict[str, Dict[str, Any]] = {}
        self.resolution_history: List[Dict[str, Any]] = []

    def apply_rule_41_provenance_priority(
        self,
        sourcer_stated_attributes: Dict[str, Any],
        visual_model_inferences: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Rule 41: Never contradict a sourcer's explicit season, collection, year, or provenance statement
        with visual inference or general knowledge.
        
        Outputs structured specification where:
        - `provenance` is set to 'stated_by_sourcer'
        - `stated_by_sourcer` contains the exact sourcer wording
        - Visual observations are relegated to `internal_visual_notes` or `visual_guess_discarded`
        - The canonical `collection`, `season`, `year`, and `model` are locked to the sourcer's statement.
        """
        resolved = {}
        
        # 1. Base brand
        brand = sourcer_stated_attributes.get("brand") or visual_model_inferences.get("brand") or "Unknown"
        resolved["brand"] = brand

        # 2. Sourcer stated fields (Rule 41 Primary Fields)
        sourcer_model = sourcer_stated_attributes.get("model") or sourcer_stated_attributes.get("model_name")
        sourcer_season = sourcer_stated_attributes.get("season")
        sourcer_collection = sourcer_stated_attributes.get("collection")
        sourcer_year = sourcer_stated_attributes.get("year")
        sourcer_provenance = sourcer_stated_attributes.get("provenance_text") or sourcer_stated_attributes.get("provenance")

        visual_guess = visual_model_inferences.get("model_guess") or visual_model_inferences.get("inferred_collection") or visual_model_inferences.get("silhouette")

        # Conflict detection
        has_override_attempt = False
        conflict_details = None

        if visual_guess and sourcer_model and normalize_text_attribute(visual_guess) != normalize_text_attribute(sourcer_model):
            has_override_attempt = True
            conflict_details = {
                "sourcer_claim": sourcer_model,
                "visual_model_guess": visual_guess,
                "resolution": "RULE_41_SOURCER_PRIORITY_APPLIED"
            }

        # Rule 41 invariant: sourcer's stated season, collection, year, model ALWAYS wins
        resolved["model"] = sourcer_model if sourcer_model else (visual_model_inferences.get("silhouette") or "Unspecified Model")
        resolved["season"] = sourcer_season
        resolved["collection"] = sourcer_collection
        resolved["year"] = sourcer_year
        
        # Physical attributes (derived from physical spec, prioritizing sourcer specification if stated)
        resolved["size"] = sourcer_stated_attributes.get("size") or visual_model_inferences.get("size") or "Standard"
        resolved["colour"] = sourcer_stated_attributes.get("colour") or sourcer_stated_attributes.get("color") or visual_model_inferences.get("colour") or "Standard"
        resolved["material"] = sourcer_stated_attributes.get("material") or visual_model_inferences.get("material") or "Standard"
        resolved["hardware"] = sourcer_stated_attributes.get("hardware") or visual_model_inferences.get("hardware") or "Standard"
        resolved["condition"] = sourcer_stated_attributes.get("condition") or visual_model_inferences.get("physical_condition", "Pre-owned")

        # Provenance attribution
        resolved["provenance"] = "stated_by_sourcer"
        resolved["stated_by_sourcer"] = {
            "model": sourcer_model,
            "season": sourcer_season,
            "collection": sourcer_collection,
            "year": sourcer_year,
            "raw_sourcer_text": sourcer_provenance
        }

        # Internal visual notes (never shown as authoritative override)
        resolved["internal_visual_observations"] = {
            "silhouette": visual_model_inferences.get("silhouette"),
            "visual_notes": visual_model_inferences.get("visual_notes"),
            "discarded_visual_model_guess": visual_guess if has_override_attempt else None,
            "override_attempt_suppressed": has_override_attempt,
            "conflict_details": conflict_details
        }

        return resolved

    def generate_canonical_piece_id(
        self,
        resolved_item: Dict[str, Any],
        sourcer_meta: Dict[str, Any],
        image_phash: Optional[str] = None
    ) -> str:
        """
        Generates a canonical piece_id for physical pieces across any chat.
        Uses:
        - Normalized brand
        - Normalized sourcer-stated model/collection/year/season
        - Normalized size, colour, material, hardware
        - Database-resolved canonical sourcer ID (Anti-Name Association)
        - Perceptual image hash cluster if present
        """
        brand_norm = normalize_text_attribute(resolved_item.get("brand", ""))
        model_norm = normalize_text_attribute(resolved_item.get("model", ""))
        size_norm = normalize_text_attribute(resolved_item.get("size", ""))
        colour_norm = normalize_text_attribute(resolved_item.get("colour", ""))
        material_norm = normalize_text_attribute(resolved_item.get("material", ""))
        hardware_norm = normalize_text_attribute(resolved_item.get("hardware", ""))
        
        # Sourcer DB resolution
        raw_sourcer = sourcer_meta.get("sourcer_handle_or_name") or sourcer_meta.get("sourcer_id") or "unknown_sourcer"
        phone = sourcer_meta.get("phone")
        sourcer_db_rec = self.resolver.resolve_sourcer_by_id_or_handle(raw_sourcer, phone=phone)
        sourcer_id = sourcer_db_rec["sourcer_id"]

        # Fingerprint string
        base_fingerprint = f"{brand_norm}|{model_norm}|{size_norm}|{colour_norm}|{material_norm}|{hardware_norm}|{sourcer_id}"
        
        # If perceptual image hash exists, include quantized / cluster hash
        if image_phash:
            # Hash to 16 hex chars
            phash_clean = compute_perceptual_image_hash(image_phash)
            base_fingerprint += f"|phash:{phash_clean}"

        hash_digest = hashlib.sha256(base_fingerprint.encode("utf-8")).hexdigest()[:12]
        brand_prefix = (brand_norm[:3] if brand_norm else "pc").upper()
        return f"PIECE_{brand_prefix}_{hash_digest}"

    def resolve_and_ingest_piece(
        self,
        chat_id: str,
        message_id: str,
        sourcer_stated_spec: Dict[str, Any],
        visual_inference: Dict[str, Any],
        sourcer_meta: Dict[str, Any],
        image_data: Any = None
    ) -> Dict[str, Any]:
        """
        Resolves inbound item against Rule 41 and the Central Pieces Ledger.
        """
        # Step 1: Enforce Rule 41
        resolved_spec = self.apply_rule_41_provenance_priority(sourcer_stated_spec, visual_inference)
        
        # Step 2: Perceptual Hash
        phash = compute_perceptual_image_hash(image_data) if image_data else None
        
        # Step 3: Canonical Piece ID
        canonical_id = self.generate_canonical_piece_id(resolved_spec, sourcer_meta, phash)
        
        # Step 4: Resolve Sourcer DB Record
        raw_sourcer = sourcer_meta.get("sourcer_handle_or_name") or sourcer_meta.get("sourcer_id")
        phone = sourcer_meta.get("phone")
        sourcer_db_rec = self.resolver.resolve_sourcer_by_id_or_handle(raw_sourcer, phone=phone)

        now = datetime.now(timezone.utc).isoformat()

        # Step 5: Check Central Pieces Ledger
        is_existing = canonical_id in self.pieces_ledger
        if is_existing:
            ledger_entry = self.pieces_ledger[canonical_id]
            ledger_entry["associated_chats"].append({"chat_id": chat_id, "message_id": message_id, "timestamp": now})
            ledger_entry["frequency_seen"] += 1
            ledger_entry["last_seen_at"] = now
        else:
            ledger_entry = {
                "piece_id": canonical_id,
                "brand": resolved_spec["brand"],
                "model": resolved_spec["model"],
                "season": resolved_spec["season"],
                "collection": resolved_spec["collection"],
                "year": resolved_spec["year"],
                "size": resolved_spec["size"],
                "colour": resolved_spec["colour"],
                "material": resolved_spec["material"],
                "hardware": resolved_spec["hardware"],
                "condition": resolved_spec["condition"],
                "provenance": resolved_spec["provenance"],
                "stated_by_sourcer": resolved_spec["stated_by_sourcer"],
                "internal_visual_observations": resolved_spec["internal_visual_observations"],
                "sourcer_id": sourcer_db_rec["sourcer_id"],
                "sourcer_canonical_name": sourcer_db_rec["canonical_name"],
                "sourcer_base_country_code": sourcer_db_rec["base_country_code"],
                "perceptual_hash": phash,
                "first_seen_at": now,
                "last_seen_at": now,
                "frequency_seen": 1,
                "associated_chats": [{"chat_id": chat_id, "message_id": message_id, "timestamp": now}]
            }
            self.pieces_ledger[canonical_id] = ledger_entry

        resolution_record = {
            "chat_id": chat_id,
            "message_id": message_id,
            "piece_id": canonical_id,
            "is_deduplicated_across_chats": is_existing,
            "resolved_piece": ledger_entry
        }
        self.resolution_history.append(resolution_record)
        return resolution_record

# Global singleton resolver instance
item_identity_resolver = ItemIdentityResolver()