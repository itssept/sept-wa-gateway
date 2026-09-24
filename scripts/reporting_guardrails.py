"""
reporting_guardrails.py
Verified Outcome Reporting Guardrails for SEPT.
"""

from dataclasses import dataclass
from typing import Optional, Literal

DeliveryStatus = Literal["queued", "attempting_to_send", "sent", "failed_to_send"]

@dataclass
class MessageDeliveryRecord:
    message_id: str
    recipient: str
    status: DeliveryStatus
    gateway_confirmed: bool = False
    error_message: Optional[str] = None

class VerifiedReportingEngine:
    @staticmethod
    def get_delivery_status(record: MessageDeliveryRecord) -> str:
        if record.gateway_confirmed and record.status == "sent":
            return f"Message {record.message_id} to {record.recipient}: Sent (Delivery Confirmed)"
        if record.status == "failed_to_send":
            return f"Message {record.message_id} to {record.recipient}: failed to send ({record.error_message or 'gateway dispatch error'})"
        if record.status == "queued":
            return f"Message {record.message_id} to {record.recipient}: queued"
        return f"Message {record.message_id} to {record.recipient}: attempting to send"

    @staticmethod
    def report_search(search_executed: bool, results_count: int, query: str) -> str:
        if not search_executed:
            return f'Search has not been run for query "{query}".'
        if results_count == 0:
            return f'Search executed: No listing found for "{query}".'
        return f'Search executed: Found {results_count} listing(s) for "{query}".'

    @staticmethod
    def transcribe_voice_note(audio_processed: bool, transcript: Optional[str] = None) -> str:
        if not audio_processed or not transcript or not transcript.strip():
            return "I couldn't process this voice note."
        return transcript.strip()

    @staticmethod
    def handle_voice_pushback() -> str:
        return "I couldn't process this voice note."
