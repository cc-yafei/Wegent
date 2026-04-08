# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP tool for creating interactive cards.

This tool allows AI agents to present a rich interactive card to the user,
optionally with async polling for status updates, a clickable URL, and
action buttons with hidden prompts.

Design:
- Card data is stored in the session block's tool_input and sent to the
  frontend via WebSocket (chat:block_updated), mirroring the interactive
  form question pattern.
- If poll_url is provided, a Celery task is enqueued to periodically fetch
  the URL, apply the configured field mapping (from system_configs), and
  push progress updates to the frontend.
- Buttons carry a visible label and a hidden prompt. When the user clicks
  a button the frontend sends the hidden prompt as the next conversation
  message so the AI can act on it without the user seeing the raw text.
- Returns __silent_exit__ so the current task ends immediately.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool

logger = logging.getLogger(__name__)


def _generate_card_id(subtask_id: int) -> str:
    """Generate a unique, deterministic card ID from the subtask ID."""
    return f"card_{subtask_id}"


async def _notify_frontend(
    task_id: int,
    subtask_id: int,
    card_data: Dict[str, Any],
) -> None:
    """Send WebSocket notification to render the interactive card on the frontend.

    Finds the create_interactive_card tool block in session_manager, updates
    its tool_input, and emits a chat:block_updated event.
    """
    try:
        from app.services.chat.storage.session import session_manager
        from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
        from shared.models.blocks import BlockStatus

        blocks = await session_manager.get_blocks(subtask_id)
        tool_use_id = None
        for block in reversed(blocks):
            tool_name = block.get("tool_name", "")
            if block.get("type") == "tool" and "create_interactive_card" in tool_name:
                tool_use_id = block.get("tool_use_id")
                break

        if not tool_use_id:
            logger.warning(
                f"[InteractiveCard] No create_interactive_card tool block found "
                f"for subtask {subtask_id}, cannot notify frontend"
            )
            return

        await session_manager.update_tool_block_status(
            subtask_id=subtask_id,
            tool_use_id=tool_use_id,
            tool_input=card_data,
        )

        ws_emitter = get_webpage_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[InteractiveCard] WebSocket emitter not available, cannot notify frontend"
            )
            return

        await ws_emitter.emit_block_updated(
            task_id=task_id,
            subtask_id=subtask_id,
            block_id=tool_use_id,
            tool_input=card_data,
            status=BlockStatus.PENDING.value,
        )
        logger.info(
            f"[InteractiveCard] Notified frontend: task_id={task_id}, "
            f"subtask_id={subtask_id}, tool_use_id={tool_use_id}"
        )
    except Exception as e:
        logger.error(
            f"[InteractiveCard] Failed to notify frontend: task_id={task_id}, "
            f"subtask_id={subtask_id}, error={e}",
            exc_info=True,
        )


@mcp_tool(
    name="create_interactive_card",
    description=(
        "Display an interactive card to the user. The card shows a title, optional "
        "description, creation time, and action buttons. Each button has a visible "
        "label and a hidden prompt that is sent to the AI when clicked. "
        "Optionally, supply poll_url to asynchronously track the progress of a "
        "background operation (the backend will periodically query the URL and push "
        "status updates to the card). Supply click_url to make the card itself "
        "clickable. Returns immediately with a silent exit."
    ),
    server="interactive_card",
    param_descriptions={
        "title": "Card title shown to the user",
        "buttons": (
            "List of action buttons. Each button must have: "
            "'label' (display text shown to user), "
            "'prompt' (hidden text sent to AI when clicked, not visible to user), "
            "and optionally 'style' ('primary' | 'secondary' | 'danger', default 'primary')."
        ),
        "description": "Optional subtitle or description shown below the title",
        "click_url": (
            "Optional URL to open when the card body is clicked. "
            "If not provided, the card body is not clickable."
        ),
        "poll_url": (
            "Optional URL to poll for status/progress updates. "
            "The backend will periodically GET this URL and update the card. "
            "Field mapping is configured via the admin system-config panel."
        ),
        "poll_interval": "Seconds between each poll request (default: 5)",
        "poll_max_retries": (
            "Maximum number of poll attempts before giving up (default: 60, ~5 minutes)"
        ),
    },
)
async def create_interactive_card(
    token_info: TaskTokenInfo,
    title: str,
    buttons: List[Dict[str, Any]],
    description: Optional[str] = None,
    click_url: Optional[str] = None,
    poll_url: Optional[str] = None,
    poll_interval: int = 5,
    poll_max_retries: int = 60,
) -> Dict[str, Any]:
    """Create and display an interactive card to the user.

    The card is rendered immediately on the frontend. If poll_url is given,
    a Celery background task starts polling the URL for status updates.

    Button prompts are never shown to the user. When a button is clicked the
    frontend sends the hidden prompt as the next conversation message.

    Returns:
        Always returns {"__silent_exit__": True} to end the current task silently.
    """
    card_id = _generate_card_id(token_info.subtask_id)

    # Normalise buttons: ensure required fields are present
    normalised_buttons = []
    for btn in buttons:
        normalised_buttons.append(
            {
                "id": btn.get("id") or f"btn_{len(normalised_buttons)}",
                "label": btn.get("label", ""),
                "prompt": btn.get("prompt", ""),
                "style": btn.get("style", "primary"),
            }
        )

    card_data: Dict[str, Any] = {
        "type": "interactive_card",
        "card_id": card_id,
        "task_id": token_info.task_id,
        "subtask_id": token_info.subtask_id,
        # Display fields
        "title": title,
        "description": description,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # Initial status
        "status": "polling" if poll_url else "pending",
        "progress": None,
        "status_text": None,
        # Clickable URL
        "click_url": click_url,
        # Buttons
        "buttons": normalised_buttons,
        # Interaction state
        "dismissed": False,
        "dismissed_label": None,
        # Polling metadata (used by Celery task; not rendered by frontend)
        "poll_url": poll_url,
        "poll_interval": poll_interval,
        "poll_max_retries": poll_max_retries,
    }

    # Notify frontend immediately so the card appears right away
    await _notify_frontend(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        card_data=card_data,
    )

    # Enqueue Celery polling task if poll_url was provided
    if poll_url:
        try:
            from app.tasks.card_tasks import poll_interactive_card_task

            poll_interactive_card_task.delay(
                task_id=token_info.task_id,
                subtask_id=token_info.subtask_id,
                card_id=card_id,
                poll_url=poll_url,
                poll_interval=poll_interval,
                retry_count=0,
                max_retries=poll_max_retries,
            )
            logger.info(
                f"[InteractiveCard] Enqueued polling task: card_id={card_id}, "
                f"poll_url={poll_url}, interval={poll_interval}s"
            )
        except Exception as e:
            logger.error(
                f"[InteractiveCard] Failed to enqueue polling task: "
                f"card_id={card_id}, error={e}",
                exc_info=True,
            )

    logger.info(
        f"[InteractiveCard] Card created: card_id={card_id}, "
        f"task={token_info.task_id}, subtask={token_info.subtask_id}, "
        f"poll={'yes' if poll_url else 'no'}"
    )
    return {
        "__silent_exit__": True,
        "reason": "interactive_card displayed; waiting for user button click",
    }
