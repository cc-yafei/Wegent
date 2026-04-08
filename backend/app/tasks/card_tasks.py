# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for interactive card async polling.

When create_interactive_card is called with a poll_url, this task is enqueued
to periodically fetch that URL and push status/progress updates to the frontend
via WebSocket until the card reaches a terminal state or the retry limit is hit.

Field mapping is loaded from the system_configs table (key: card_poll_field_mappings).
The mapping with url_pattern matching poll_url is applied to extract the normalised
card fields (status, progress, status_text, click_url) from the raw response body.
"""

import asyncio
import json
import logging
import re
from typing import Any, Dict, Optional

import requests

from app.core.celery_app import celery_app
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

CARD_FIELD_MAPPINGS_CONFIG_KEY = "card_poll_field_mappings"

# Terminal statuses – polling stops when the card reaches one of these
TERMINAL_STATUSES = {"completed", "failed"}


# ─── Field mapping helpers ─────────────────────────────────────────────────────


def _get_nested(data: Any, path: str) -> Any:
    """Resolve a dot-separated JSONPath-style key from a dict (e.g., 'data.state')."""
    parts = path.split(".")
    current = data
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _load_field_mappings() -> list:
    """Load card poll field mappings from system_configs."""
    try:
        from app.models.system_config import SystemConfig

        with SessionLocal() as db:
            config = (
                db.query(SystemConfig)
                .filter(SystemConfig.config_key == CARD_FIELD_MAPPINGS_CONFIG_KEY)
                .first()
            )
            if not config:
                return []
            value = config.config_value or {}
            return value.get("mappings", [])
    except Exception as e:
        logger.warning(f"[InteractiveCard] Failed to load field mappings: {e}")
        return []


def _find_mapping(url: str, mappings: list) -> Optional[Dict[str, Any]]:
    """Return the first mapping whose url_pattern matches the given URL."""
    for mapping in mappings:
        pattern = mapping.get("url_pattern", "")
        if pattern and re.search(pattern, url):
            return mapping
    return None


def _normalise_status(raw_status: Any, status_value_mapping: Dict[str, list]) -> str:
    """Map a raw response status value to one of: completed / failed / polling."""
    if raw_status is None:
        return "polling"
    raw_str = str(raw_status).lower()
    for canonical, aliases in status_value_mapping.items():
        if raw_str in [a.lower() for a in aliases]:
            return canonical
    return "polling"


def _apply_mapping(
    response_body: Any,
    field_mapping: Dict[str, str],
    status_value_mapping: Dict[str, list],
) -> Dict[str, Any]:
    """Extract normalised card update fields from a response body using field_mapping."""
    update: Dict[str, Any] = {}

    raw_status = (
        _get_nested(response_body, field_mapping.get("status", ""))
        if field_mapping.get("status")
        else None
    )
    update["status"] = _normalise_status(raw_status, status_value_mapping)

    if "progress" in field_mapping:
        update["progress"] = _get_nested(response_body, field_mapping["progress"])

    if "status_text" in field_mapping:
        update["status_text"] = _get_nested(response_body, field_mapping["status_text"])

    if "click_url" in field_mapping:
        update["click_url"] = _get_nested(response_body, field_mapping["click_url"])

    return update


# ─── WebSocket push helper (sync wrapper around async emit) ────────────────────


def _push_card_update(task_id: int, subtask_id: int, card_data: Dict[str, Any]) -> None:
    """Push updated card data to the frontend via WebSocket (run in new event loop)."""

    async def _emit() -> None:
        try:
            from app.services.chat.storage.session import session_manager
            from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
            from shared.models.blocks import BlockStatus

            # Find the tool block created by create_interactive_card
            blocks = await session_manager.get_blocks(subtask_id)
            tool_use_id = None
            for block in reversed(blocks):
                tool_name = block.get("tool_name", "")
                if (
                    block.get("type") == "tool"
                    and "create_interactive_card" in tool_name
                ):
                    tool_use_id = block.get("tool_use_id")
                    break

            if not tool_use_id:
                return

            await session_manager.update_tool_block_status(
                subtask_id=subtask_id,
                tool_use_id=tool_use_id,
                tool_input=card_data,
            )

            ws_emitter = get_webpage_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_block_updated(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    block_id=tool_use_id,
                    tool_input=card_data,
                    status=BlockStatus.PENDING.value,
                )
        except Exception as e:
            logger.warning(f"[InteractiveCard] Push update failed: {e}")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_emit())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


# ─── Celery task ───────────────────────────────────────────────────────────────


@celery_app.task(
    bind=True,
    name="app.tasks.card_tasks.poll_interactive_card",
    max_retries=None,  # Controlled by retry_count / max_retries arguments
)
def poll_interactive_card_task(
    self,
    task_id: int,
    subtask_id: int,
    card_id: str,
    poll_url: str,
    poll_interval: int,
    retry_count: int,
    max_retries: int,
):
    """Poll poll_url for card status and push updates to the frontend.

    This task re-schedules itself via apply_async(countdown=poll_interval)
    until the status is terminal or max_retries is exhausted.
    """
    logger.info(
        f"[InteractiveCard] Polling: card_id={card_id}, attempt={retry_count + 1}/{max_retries}, "
        f"url={poll_url}"
    )

    # Load field mappings from system_configs
    mappings = _load_field_mappings()
    mapping_cfg = _find_mapping(poll_url, mappings)
    field_mapping: Dict[str, str] = {}
    status_value_mapping: Dict[str, list] = {
        "completed": ["completed", "done", "success", "finished"],
        "failed": ["failed", "error", "timeout"],
        "polling": ["running", "processing", "in_progress", "pending"],
    }
    if mapping_cfg:
        field_mapping = mapping_cfg.get("field_mapping", {})
        status_value_mapping.update(mapping_cfg.get("status_value_mapping", {}))

    # Fetch the URL
    card_update: Dict[str, Any] = {}
    try:
        response = requests.get(poll_url, timeout=10)
        response.raise_for_status()
        try:
            body = response.json()
        except ValueError:
            body = {"raw": response.text}

        if field_mapping:
            card_update = _apply_mapping(body, field_mapping, status_value_mapping)
        else:
            # No mapping configured: try to detect status from common field names
            card_update = {"status": "polling"}
            for key in ("status", "state", "progress", "message"):
                if key in body:
                    if key == "status":
                        card_update["status"] = _normalise_status(
                            body[key], status_value_mapping
                        )
                    elif key == "progress":
                        card_update["progress"] = body[key]
                    elif key == "message":
                        card_update["status_text"] = body[key]

    except requests.Timeout:
        logger.warning(f"[InteractiveCard] Poll timeout: card_id={card_id}")
        card_update = {"status": "polling", "status_text": None}
    except Exception as e:
        logger.warning(f"[InteractiveCard] Poll error: card_id={card_id}, error={e}")
        card_update = {"status": "polling", "status_text": None}

    # Load current card_data from Redis, merge update, push to frontend
    async def _merge_and_push() -> Dict[str, Any]:
        from app.services.chat.storage.session import session_manager

        blocks = await session_manager.get_blocks(subtask_id)
        current_card: Dict[str, Any] = {}
        for block in reversed(blocks):
            if block.get("type") == "tool" and "create_interactive_card" in block.get(
                "tool_name", ""
            ):
                raw_input = block.get("tool_input") or {}
                if isinstance(raw_input, str):
                    try:
                        raw_input = json.loads(raw_input)
                    except ValueError:
                        raw_input = {}
                current_card = raw_input
                break

        current_card.update(card_update)
        return current_card

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        merged = loop.run_until_complete(_merge_and_push())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()

    _push_card_update(task_id, subtask_id, merged)

    current_status = card_update.get("status", "polling")
    if current_status in TERMINAL_STATUSES:
        logger.info(
            f"[InteractiveCard] Polling complete: card_id={card_id}, "
            f"final_status={current_status}"
        )
        return {"status": "done", "card_id": card_id, "final_status": current_status}

    next_retry = retry_count + 1
    if next_retry >= max_retries:
        logger.info(
            f"[InteractiveCard] Polling max retries reached: card_id={card_id}, "
            f"retries={next_retry}"
        )
        return {"status": "max_retries", "card_id": card_id}

    # Schedule the next poll
    poll_interactive_card_task.apply_async(
        kwargs={
            "task_id": task_id,
            "subtask_id": subtask_id,
            "card_id": card_id,
            "poll_url": poll_url,
            "poll_interval": poll_interval,
            "retry_count": next_retry,
            "max_retries": max_retries,
        },
        countdown=poll_interval,
    )
    logger.info(
        f"[InteractiveCard] Next poll scheduled: card_id={card_id}, "
        f"retry={next_retry}, in {poll_interval}s"
    )
    return {"status": "scheduled", "card_id": card_id, "next_retry": next_retry}
