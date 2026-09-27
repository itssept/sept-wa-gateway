"""
truthful_reporting_guard.py — Enforce verify-before-reporting across every bot response.

Mission: Enforce verify-before-reporting across all SEPT bot responses and tools.

Core Invariants & Requirements:
1. Message Delivery Ack Invariant:
   - Message status is strictly tied to Baileys delivery acks.
   - Only a verified Baileys delivery ack earns "Sent".
   - In the absence of an ack (queued in memory, dropped by gateway, network timeout),
     the status must be "queued", "attempting to send", or "failed to send".
   - Never report "Sent" when dropped or merely queued.

2. Inventory Search Execution Invariant:
   - Tool wrappers strictly verify that a genuine search against the sourcing inventory ledger
     was executed before any "No listing found" / "none found" / "Nothing has come through the groups yet" answer.
   - If no search was executed, attempting to state "no listing found" or claiming unavailability is blocked / invalid.

3. Voice Note Audio Guardrail Invariant:
   - On audio decoding failure, truncation, corrupt bytes, or missing audio data, return EXACTLY:
     "I couldn't process this voice note"
   - Under NO circumstances guess, hallucinate, or speculatively fill transcripts, even under user pushback
     ("just tell me what it said", "give your best guess", "what did the audio say?").
"""

from typing import Dict, Any, List, Optional, Union
import uuid
import re
from datetime import datetime, timezone


# ==============================================================================
# 1. MESSAGE DELIVERY STATUS TRACKER (Baileys Ack Plumbing)
# ==============================================================================

VALID_STATUSES = {"queued", "attempting to send", "Sent", "failed to send"}

class MessageDeliveryStatusTracker:
    """
    Tracks and validates message delivery status strictly against Baileys delivery acks.
    """
    def __init__(self):
        self.messages: Dict[str, Dict[str, Any]] = {}
        self.delivery_audit_log: List[Dict[str, Any]] = []

    def queue_message(self, message_id: str, recipient: str, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        record = {
            "message_id": message_id,
            "recipient": recipient,
            "text": text,
            "status": "queued",
            "baileys_ack_received": False,
            "baileys_ack_timestamp": None,
            "gateway_dropped": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {}
        }
        self.messages[message_id] = record
        self._log_audit(message_id, "queued", "Message queued in memory.")
        return record

    def mark_attempting_send(self, message_id: str) -> Dict[str, Any]:
        if message_id not in self.messages:
            raise KeyError(f"Message {message_id} not found.")
        msg = self.messages[message_id]
        msg["status"] = "attempting to send"
        msg["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._log_audit(message_id, "attempting to send", "Sent to gateway socket, awaiting Baileys ack.")
        return msg

    def record_baileys_ack(self, message_id: str, ack_payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if message_id not in self.messages:
            raise KeyError(f"Message {message_id} not found.")
        msg = self.messages[message_id]
        msg["baileys_ack_received"] = True
        msg["baileys_ack_timestamp"] = datetime.now(timezone.utc).isoformat()
        msg["status"] = "Sent"
        msg["updated_at"] = datetime.now(timezone.utc).isoformat()
        msg["ack_payload"] = ack_payload or {}
        self._log_audit(message_id, "Sent", "Baileys delivery ack verified.")
        return msg

    def record_gateway_drop(self, message_id: str, reason: str = "Gateway dropped socket message before delivery ack") -> Dict[str, Any]:
        if message_id not in self.messages:
            raise KeyError(f"Message {message_id} not found.")
        msg = self.messages[message_id]
        msg["gateway_dropped"] = True
        msg["baileys_ack_received"] = False
        msg["status"] = "failed to send"
        msg["updated_at"] = datetime.now(timezone.utc).isoformat()
        msg["failure_reason"] = reason
        self._log_audit(message_id, "failed to send", f"Drop recorded: {reason}")
        return msg

    def get_public_status_report(self, message_id: str) -> str:
        """
        Returns truthful status report string.
        Guarantees that a dropped or unacknowledged message is NEVER reported as 'Sent'.
        """
        if message_id not in self.messages:
            return "unknown message"
        msg = self.messages[message_id]
        if not msg["baileys_ack_received"]:
            if msg["gateway_dropped"]:
                return "failed to send"
            return msg["status"]  # "queued" or "attempting to send"
        return "Sent"

    def _log_audit(self, message_id: str, status: str, details: str):
        self.delivery_audit_log.append({
            "audit_id": str(uuid.uuid4()),
            "message_id": message_id,
            "status": status,
            "details": details,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })


# ==============================================================================
# 2. INVENTORY SEARCH EXECUTION GATE
# ==============================================================================

class InventorySearchExecutionGate:
    """
    Gate requiring actual execution of search queries against inventory before
    any claim of 'No listing found', 'none found', or 'Nothing has come through the groups yet'.
    """
    def __init__(self, inventory_data: Optional[List[Dict[str, Any]]] = None):
        self.inventory = inventory_data or []
        self.executed_searches: List[Dict[str, Any]] = []

    def execute_inventory_search(self, query_params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Runs real search over inventory records.
        """
        search_id = str(uuid.uuid4())
        brand = (query_params.get("brand") or "").strip().lower()
        model = (query_params.get("model") or "").strip().lower()
        colour = (query_params.get("colour") or query_params.get("color") or "").strip().lower()
        size = str(query_params.get("size") or "").strip().lower()

        results = []
        for item in self.inventory:
            match = True
            if brand and brand not in item.get("brand", "").lower():
                match = False
            if model and model not in item.get("model", "").lower():
                match = False
            if colour and colour not in item.get("colour", "").lower():
                match = False
            if size and size not in str(item.get("size", "")).lower():
                match = False
            if match:
                results.append(item)

        search_record = {
            "search_id": search_id,
            "query_params": query_params,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "results_count": len(results),
            "results": results
        }
        self.executed_searches.append(search_record)
        return results

    def verify_and_format_availability_response(self, query_params: Dict[str, Any], search_executed: bool = True) -> Dict[str, Any]:
        """
        Validates whether a search actually ran before returning an answer.
        If no search ran, blocks unverified 'none found' responses.
        """
        if not search_executed or not self._has_matching_search(query_params):
            return {
                "verified": False,
                "error": "SEARCH_NOT_EXECUTED",
                "message": "Unverified: Inventory search was not executed. Cannot report availability or 'none found' without querying the ledger."
            }

        # Retrieve the latest executed search matching the query
        search_record = self._get_latest_search(query_params)
        count = search_record["results_count"]
        
        if count == 0:
            return {
                "verified": True,
                "status": "NO_LISTING_FOUND",
                "results_count": 0,
                "message": "No listing found in the operator's sourcing inventory.",
                "search_id": search_record["search_id"]
            }
        else:
            return {
                "verified": True,
                "status": "LISTINGS_FOUND",
                "results_count": count,
                "items": search_record["results"],
                "message": f"Found {count} listing(s) matching request in inventory.",
                "search_id": search_record["search_id"]
            }

    def _has_matching_search(self, query_params: Dict[str, Any]) -> bool:
        for s in self.executed_searches:
            # Check if params match
            if all(s["query_params"].get(k) == v for k, v in query_params.items()):
                return True
        return False

    def _get_latest_search(self, query_params: Dict[str, Any]) -> Dict[str, Any]:
        for s in reversed(self.executed_searches):
            if all(s["query_params"].get(k) == v for k, v in query_params.items()):
                return s
        return {}


# ==============================================================================
# 3. VOICE NOTE AUDIO GUARDRAIL
# ==============================================================================

FIXED_VOICE_NOTE_ERROR = "I couldn't process this voice note"

PUSHBACK_PATTERNS = [
    re.compile(r"just tell me what it said", re.IGNORECASE),
    re.compile(r"what did (the voice note|it|the audio|she|he) say", re.IGNORECASE),
    re.compile(r"give (me )?(your )?best guess", re.IGNORECASE),
    re.compile(r"can you guess", re.IGNORECASE),
    re.compile(r"summarize anyway", re.IGNORECASE),
    re.compile(r"just guess", re.IGNORECASE),
    re.compile(r"try to transcribe anyway", re.IGNORECASE),
    re.compile(r"tell me anyway", re.IGNORECASE)
]

class VoiceNoteAudioGuardrail:
    """
    Strict audio decoding guardrail:
    - If audio decoding fails, is truncated, corrupt, or missing: return strictly FIXED_VOICE_NOTE_ERROR.
    - If user pushes back asking for a guess or approximate content on a failed audio note,
      strictly return FIXED_VOICE_NOTE_ERROR.
    """
    def __init__(self):
        self.transcription_sessions: Dict[str, Dict[str, Any]] = {}

    def process_voice_note(
        self,
        audio_id: str,
        audio_bytes: Optional[bytes] = None,
        is_corrupt: bool = False,
        is_truncated: bool = False,
        mock_raw_transcript: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Evaluates audio integrity.
        """
        # Check audio integrity
        if audio_bytes is None or len(audio_bytes) == 0 or is_corrupt or is_truncated:
            record = {
                "audio_id": audio_id,
                "status": "FAILED",
                "reason": "Truncated, missing, or corrupted audio bytes",
                "transcript": None,
                "response_text": FIXED_VOICE_NOTE_ERROR,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            self.transcription_sessions[audio_id] = record
            return record

        # Valid audio processing
        record = {
            "audio_id": audio_id,
            "status": "SUCCESS",
            "transcript": mock_raw_transcript or "",
            "response_text": mock_raw_transcript or "",
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        self.transcription_sessions[audio_id] = record
        return record

    def handle_user_pushback(self, audio_id: str, user_prompt: str) -> str:
        """
        Handles pushback attempts like 'just tell me what it said' on a failed voice note.
        Must NEVER guess or provide speculative fills.
        """
        session = self.transcription_sessions.get(audio_id)
        if not session or session["status"] != "SUCCESS":
            # For failed or unprocessable voice note, return exact fixed string
            return FIXED_VOICE_NOTE_ERROR

        # If audio was successfully transcribed previously, return actual transcript
        return session["transcript"]