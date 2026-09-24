"""
combined_proactive_runner.py — Master Proactive Scheduler Entrypoint for SEPT Operators.

Can be run directly or triggered via PromptQL scheduled triggers.
Inspects local time of run to execute either Morning Briefing or Evening Recap,
and handles sourcer 24-hour follow-up drafts.
"""

from datetime import datetime, timezone
from proactive_runs import ProactiveEngine, run_proactive_cycle
from executor import aio, executor

async def main():
    executor.print("Executing automated proactive engine cycle...")
    await run_proactive_cycle()
    executor.print("Proactive engine cycle completed successfully.")