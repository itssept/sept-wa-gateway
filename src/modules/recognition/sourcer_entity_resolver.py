"""
sourcer_entity_resolver.py — Database-ID Bound Entity Retrieval (Anti-Name Association).

Enforces Invariant:
1. Sourcer/operator matching runs ONLY on relational queries against the `sourcers` table / registry.
2. Prompts and matching pipelines receive structured records only:
   `{ sourcer_id, base_country_code, specialties, verified_locations }`
3. Misleading substrings in handles/names (e.g. '.paris', '.london', 'paris', 'london') are stripped
   before any semantic classification, ensuring names do not leak into assumed location/capabilities.
4. If sourcer is not in DB -> returns unknown sourcer with empty/unverified attributes, NOT invented attributes.
5. No sourcer location or capability appears unless it is explicitly present in the DB record.
"""

import re
from typing import Dict, List, Optional, Any
from executor import aio, executor

# Misleading geographical and institutional substrings to strip from handles/names
MISLEADING_SUBSTRINGS = [
    "paris", "london", "milan", "nyc", "newyork", "tokyo", 
    "dubai", "beirut", "monaco", "geneva", "rome", "madrid"
]

def sanitize_handle_for_classification(raw_handle_or_name: str) -> str:
    """
    Strips misleading geographical and institutional substrings from handles/names
    before any semantic classification or downstream prompt ingestion.
    """
    if not raw_handle_or_name:
        return ""
    
    # Replace separators with spaces first to split word boundaries cleanly
    text = raw_handle_or_name.strip().lstrip("@")
    text = re.sub(r"[._\-]+", " ", text)
    
    # Remove any word or token that matches misleading locations
    tokens = text.split()
    cleaned_tokens = [t for t in tokens if t.lower() not in MISLEADING_SUBSTRINGS]
    
    # Also handle compound tokens if any (e.g. lesintemporelsparis -> lesintemporels)
    final_tokens = []
    for t in cleaned_tokens:
        curr = t
        for loc in MISLEADING_SUBSTRINGS:
            if curr.lower().endswith(loc) and len(curr) > len(loc):
                curr = curr[:-len(loc)]
            elif curr.lower().startswith(loc) and len(curr) > len(loc):
                curr = curr[len(loc):]
        if curr:
            final_tokens.append(curr)
            
    return " ".join(final_tokens).strip()

# Canonical Relational Sourcers DB Table (In-memory representation & Virtual SQL backing)
DEFAULT_SOURCERS_DB: Dict[str, Dict[str, Any]] = {
    "src_les_intemporels": {
        "sourcer_id": "src_les_intemporels",
        "canonical_name": "Les Intemporels",
        "handles": ["@lesintemporels.paris", "@les_intemporels_paris", "lesintemporels.paris", "les intemporels paris", "les intemporels", "lesintemporels"],
        "phone": "+961 81 324 102",
        "phone_country_code": "+961",
        "base_country_code": "LB",  # Lebanon
        "base_country_name": "Lebanon",
        "base_city": "Beirut",
        "specialties": ["Vintage pieces", "Archival Luxury", "Chanel Vintage"],
        "verified_locations": ["Beirut"],
        "shipping_routes": ["China", "Hong Kong", "Monaco", "Los Angeles"],
        "in_store_runners": False,
        "verified_boutiques": []
    },
    "src_luv_story": {
        "sourcer_id": "src_luv_story",
        "canonical_name": "Luv Story",
        "handles": ["@its_aluvstory", "its_aluvstory", "luv story london", "luv story", "its aluvstory"],
        "phone": "+44 7700 900077",
        "phone_country_code": "+44",
        "base_country_code": "GB",  # United Kingdom
        "base_country_name": "United Kingdom",
        "base_city": "London",
        "specialties": ["Hermès", "Chanel Ready-to-Wear"],
        "verified_locations": ["London"],
        "shipping_routes": ["UK", "GCC"],
        "in_store_runners": False,
        "verified_boutiques": []  # Strictly NO Bond Street / Harrods unless in DB
    },
    "src_edp_luxury": {
        "sourcer_id": "src_edp_luxury",
        "canonical_name": "EDP Luxury",
        "handles": ["@edp_luxury", "edp_luxury", "edp"],
        "phone": "+33 6 12 34 56 78",
        "phone_country_code": "+33",
        "base_country_code": "FR",  # France
        "base_country_name": "France",
        "base_city": "Paris",
        "specialties": ["Chanel", "Hermès Quotas"],
        "verified_locations": ["Paris"],
        "shipping_routes": ["EU", "Worldwide"],
        "in_store_runners": True,
        "verified_boutiques": ["Rue Cambon"]
    }
}

class SourcerEntityResolver:
    """
    Relational DB-ID bound entity resolver for sourcers and operators.
    Enforces that NO capabilities or locations are inferred from raw string names.
    """
    def __init__(self, db_records: Optional[Dict[str, Dict[str, Any]]] = None):
        self._db = db_records or DEFAULT_SOURCERS_DB
        self._lookup_index = {}
        self._build_index()
        
    def _build_index(self):
        for s_id, record in self._db.items():
            # index by sourcer_id
            self._lookup_index[s_id.lower()] = record
            # index by canonical name
            self._lookup_index[record["canonical_name"].lower()] = record
            # index by raw handles
            for h in record.get("handles", []):
                clean_h = h.lstrip("@").lower().strip()
                self._lookup_index[clean_h] = record
                # Also index sanitized handle
                sanitized = sanitize_handle_for_classification(clean_h).lower()
                if sanitized:
                    self._lookup_index[sanitized] = record

    def resolve_sourcer_by_id_or_handle(self, identifier: str, phone: Optional[str] = None) -> Dict[str, Any]:
        """
        Resolves sourcer strictly against the DB.
        Returns the structured record:
        { sourcer_id, base_country_code, specialties, verified_locations, ... }
        If not found, returns unknown sourcer with no invented capabilities.
        """
        if not identifier:
            return self._unknown_record("unknown")

        raw_clean = identifier.strip().lstrip("@").lower()
        
        # 1. Direct match on DB index
        if raw_clean in self._lookup_index:
            rec = self._lookup_index[raw_clean]
            return self.format_structured_record(rec)
            
        # 2. Match on sanitized handle
        sanitized = sanitize_handle_for_classification(raw_clean)
        if sanitized and sanitized.lower() in self._lookup_index:
            rec = self._lookup_index[sanitized.lower()]
            return self.format_structured_record(rec)

        # 3. Match on phone prefix / phone number if provided
        if phone:
            norm_phone = re.sub(r"[^\d+]", "", phone)
            for rec in self._db.values():
                rec_phone = re.sub(r"[^\d+]", "", rec.get("phone", ""))
                if rec_phone and (norm_phone == rec_phone or norm_phone.startswith(rec.get("phone_country_code", ""))):
                    if norm_phone == rec_phone or sanitized in rec["canonical_name"].lower():
                        return self.format_structured_record(rec)

        # 4. Not in DB -> strictly unknown sourcer
        return self._unknown_record(identifier)

    def format_structured_record(self, rec: Dict[str, Any]) -> Dict[str, Any]:
        """
        Formats record into the strict invariant schema:
        { sourcer_id, base_country_code, specialties, verified_locations }
        """
        return {
            "sourcer_id": rec["sourcer_id"],
            "canonical_name": rec.get("canonical_name", ""),
            "base_country_code": rec.get("base_country_code", "UNKNOWN"),
            "base_country_name": rec.get("base_country_name", "Unknown"),
            "base_city": rec.get("base_city", "Unknown"),
            "specialties": list(rec.get("specialties", [])),
            "verified_locations": list(rec.get("verified_locations", [])),
            "shipping_routes": list(rec.get("shipping_routes", [])),
            "in_store_runners": rec.get("in_store_runners", False),
            "verified_boutiques": list(rec.get("verified_boutiques", [])),
            "is_verified_in_db": True,
            "provenance": "relational_db_lookup"
        }

    def _unknown_record(self, raw_identifier: str) -> Dict[str, Any]:
        return {
            "sourcer_id": "unknown_sourcer",
            "canonical_name": "unknown sourcer",
            "raw_input": raw_identifier,
            "base_country_code": "UNKNOWN",
            "base_country_name": "Unknown",
            "base_city": "Unknown",
            "specialties": [],
            "verified_locations": [],
            "shipping_routes": [],
            "in_store_runners": False,
            "verified_boutiques": [],
            "is_verified_in_db": False,
            "provenance": "unverified_not_in_db"
        }

    def sanitize_prompt_context(self, sourcer_identifier: str, phone: Optional[str] = None) -> Dict[str, Any]:
        """
        Provides prompt-ready structured records only.
        Ensures prompts NEVER receive raw ungrounded strings that could induce hallucinated locations.
        """
        structured = self.resolve_sourcer_by_id_or_handle(sourcer_identifier, phone=phone)
        return {
            "sourcer_id": structured["sourcer_id"],
            "base_country_code": structured["base_country_code"],
            "specialties": structured["specialties"],
            "verified_locations": structured["verified_locations"]
        }

# Global singleton resolver instance
sourcer_resolver = SourcerEntityResolver()