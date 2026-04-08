---
name: "interactive-card"
description: "Display an interactive card to the user with a title, optional progress tracking, action buttons, and an optional clickable URL. Use when you need user confirmation before a significant action, or to show async task progress without exposing technical details."
displayName: "交互式卡片"
version: "1.0.0"
author: "Wegent Team"
tags: ["interaction", "confirmation", "card", "async", "progress"]
bindShells:
  - Chat
  - Agno
  - ClaudeCode
mcpServers:
  wegent-interactive-card:
    type: streamable-http
    url: "${{backend_url}}/mcp/interactive-card/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 60
---

# Interactive Card

You now have access to the `create_interactive_card` tool. Use it to present decisions or async progress to the user in a visually rich card format.

## When to Use

1. **Confirm before significant actions** — executing SQL, deleting data, sending emails, making API calls
2. **Show async operation progress** — polling a background job without exposing the raw API response
3. **Present a summary with a decision** — show what will happen and let the user approve or cancel
4. **Link to external resources** — card can be clicked to open a URL (reports, dashboards, etc.)

**Never describe the action in plain text and ask "shall I proceed?" — always use `create_interactive_card`.**

## Behavior

`create_interactive_card` renders an interactive card and returns immediately (`__silent_exit__`).
The task ends silently and resumes when the user clicks one of the card's action buttons.
The button's `prompt` (hidden from the user) is sent as the next conversation message.

If `poll_url` is provided, the backend periodically queries that URL and updates the card's
progress bar and status text in real-time.

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | ✅ | Card title shown to the user |
| `buttons` | list | ✅ | Action buttons (see below) |
| `description` | string | — | Subtitle or additional context |
| `click_url` | string | — | URL to open when the card body is clicked |
| `poll_url` | string | — | URL to poll for status/progress updates |
| `poll_interval` | int | — | Seconds between polls (default: 5) |
| `poll_max_retries` | int | — | Max polls before giving up (default: 60 ≈ 5 min) |

### Button Object

| Field | Required | Description |
|-------|----------|-------------|
| `label` | ✅ | Button text shown to the user |
| `prompt` | ✅ | Hidden text sent to AI when button is clicked (user never sees this) |
| `style` | — | `"primary"` (default) \| `"secondary"` \| `"danger"` |

## Examples

### Confirm before executing SQL

```
create_interactive_card(
  title="执行数据保存",
  description="即将向 orders 表写入 152 条记录",
  buttons=[
    {
      "label": "确认执行",
      "prompt": "用户已确认。请执行之前准备好的 INSERT SQL 语句并返回结果。",
      "style": "primary"
    },
    {
      "label": "取消",
      "prompt": "用户取消了操作。请告知用户操作已取消，询问是否需要调整。",
      "style": "secondary"
    }
  ]
)
```

### Show async job progress

```
create_interactive_card(
  title="数据处理任务",
  description="正在处理上传的 CSV 文件",
  poll_url="https://internal-api/jobs/123/status",
  poll_interval=3,
  click_url="https://dashboard.example.com/jobs/123",
  buttons=[
    {
      "label": "查看详情",
      "prompt": "用户想了解任务详情。请总结当前任务状态并提供下一步建议。",
      "style": "secondary"
    }
  ]
)
```

### Confirm sending an email

```
create_interactive_card(
  title="发送报告邮件",
  description="将向 team@example.com 发送月度报告（附件已准备好）",
  buttons=[
    {
      "label": "立即发送",
      "prompt": "用户确认发送。请调用 send_email 工具执行发送并告知用户发送结果。",
      "style": "primary"
    },
    {
      "label": "暂不发送",
      "prompt": "用户选择暂不发送。请告知用户邮件已保存为草稿。",
      "style": "secondary"
    }
  ]
)
```

## Important Notes

- **Prompts are hidden** — users see only `label`; the `prompt` is sent silently to the AI
- **poll_url field mapping** — configure URL-to-field mappings in the admin panel under System Config → Card Poll Field Mappings
- **No timeout handling** — if polling times out, the card stays visible; users can still click buttons
- After the user clicks a button, AI should act on the hidden `prompt` directly
