"""
SEPT Voice Note & Operational Status Mutation Processor
Translates voice note transcriptions and conversational operator confirmations
into transactional ledger mutations.
"""

import re
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

STATUS_KEYWORDS_MAP = {
    "delivered": {"lifecycle_status": "delivered", "fulfillment_stage": "courier_delivered"},
    "arrived": {"lifecycle_status": "delivered", "fulfillment_stage": "courier_delivered"},
    "complete": {"status": "complete", "lifecycle_status": "fulfilled"},
    "fulfilled": {"status": "complete", "lifecycle_status": "fulfilled"},
    "paid": {"payment_status": "paid", "payout_status": "paid"},
    "settled": {"payment_status": "paid", "payout_status": "paid"},
    "sold out": {"lifecycle_status": "sold_out", "status": "closed_sold_out"},
    "out of stock": {"lifecycle_status": "sold_out", "status": "closed_sold_out"}
}

class VoiceNoteStatusSync:
    """
    Parses conversational operator cues from voice note transcripts or chat updates
    and generates structured ledger mutations.
    """
    
    @classmethod
    def parse_transcript_for_mutations(cls, transcript: str, entity_context: Dict[str, Any]) -> List[Dict[str, Any]]:
        mutations = []
        text_lower = transcript.lower()
        
        for kw, status_fields in STATUS_KEYWORDS_MAP.items():
            pattern = rf"\b{re.escape(kw)}\b"
            if re.search(pattern, text_lower):
                mutation = {
                    "entity_id": entity_context.get("entity_id"),
                    "entity_type": entity_context.get("entity_type", "deal"),
                    "matched_keyword": kw,
                    "applied_fields": status_fields,
                    "source_transcript_snippet": transcript[:100],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "mutation_type": "STRUCTURED_LEDGER_UPDATE"
                }
                mutations.append(mutation)
                
        return mutations

    @classmethod
    def apply_ledger_mutation(cls, current_record: Dict[str, Any], mutations: List[Dict[str, Any]]) -> Dict[str, Any]:
        updated_record = dict(current_record)
        for m in mutations:
            updated_record.update(m["applied_fields"])
            updated_record["last_mutated_at"] = m["updated_at"]
        return updated_record
