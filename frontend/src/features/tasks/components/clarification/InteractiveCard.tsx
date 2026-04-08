// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { InteractiveCardData, InteractiveCardButton } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskStateMachine } from '../../hooks/useTaskStateMachine'

interface InteractiveCardProps {
  data: InteractiveCardData
  taskId: number
  currentMessageIndex: number
  blockStatus?: string
  onSubmit?: (cardId: string, prompt: string) => void
}

function ProgressBar({ progress }: { progress: number }) {
  const clamped = Math.min(100, Math.max(0, progress))
  return (
    <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
      <div
        className="h-full bg-primary rounded-full transition-all duration-500"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

function StatusBadge({
  status,
  t,
}: {
  status: InteractiveCardData['status']
  t: (k: string) => string
}) {
  const map: Record<string, string> = {
    polling: 'text-text-secondary',
    completed: 'text-green-600',
    failed: 'text-red-500',
    pending: 'text-text-secondary',
  }
  const labelMap: Record<string, string> = {
    polling: t('interactive_card.status_polling'),
    completed: t('interactive_card.status_completed'),
    failed: t('interactive_card.status_failed'),
    pending: t('interactive_card.status_pending'),
  }
  return (
    <span className={`text-xs font-medium ${map[status] ?? 'text-text-secondary'}`}>
      {labelMap[status] ?? status}
    </span>
  )
}

export function InteractiveCard({
  data,
  taskId,
  currentMessageIndex,
  onSubmit,
}: InteractiveCardProps) {
  const { t } = useTranslation('chat')
  const [localDismissed, setLocalDismissed] = useState(false)
  const [localDismissedLabel, setLocalDismissedLabel] = useState<string | null>(null)

  const { messages } = useTaskStateMachine(taskId)

  // Card is submitted once a user message exists after currentMessageIndex
  const isSubmitted = useMemo(() => {
    if (localDismissed || data.dismissed) return true
    if (!messages) return false
    const arr = Array.from(messages.values())
    return arr.slice(currentMessageIndex + 1).some(m => m.role === 'user')
  }, [localDismissed, data.dismissed, messages, currentMessageIndex])

  const dismissedLabel = localDismissedLabel ?? data.dismissed_label ?? null

  const handleButtonClick = (btn: InteractiveCardButton) => {
    if (isSubmitted) return
    setLocalDismissed(true)
    setLocalDismissedLabel(btn.label)
    onSubmit?.(data.card_id, btn.prompt)
  }

  const formattedDate = (() => {
    try {
      return new Date(data.created_at).toLocaleString()
    } catch {
      return data.created_at
    }
  })()

  const CardBody = (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary truncate">{data.title}</span>
            {data.click_url && (
              <ExternalLink className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
            )}
          </div>
          {data.description && (
            <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{data.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <StatusBadge status={data.status} t={t} />
          <span className="text-[10px] text-text-muted">
            {t('interactive_card.created_at')} {formattedDate}
          </span>
        </div>
      </div>

      {/* Progress */}
      {typeof data.progress === 'number' && (
        <div className="flex flex-col gap-1">
          <ProgressBar progress={data.progress} />
          <div className="flex justify-between text-[10px] text-text-muted">
            <span>{data.status_text ?? ''}</span>
            <span>{data.progress}%</span>
          </div>
        </div>
      )}

      {/* Status text (no progress bar) */}
      {typeof data.progress !== 'number' && data.status_text && (
        <p className="text-xs text-text-muted">{data.status_text}</p>
      )}

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Button row or dismissed state */}
      {isSubmitted ? (
        <p className="text-xs text-text-secondary">
          {t('interactive_card.dismissed').replace('{{label}}', dismissedLabel ?? '')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.buttons.map(btn => {
            const variantMap: Record<string, 'primary' | 'outline' | 'destructive'> = {
              primary: 'primary',
              secondary: 'outline',
              danger: 'destructive',
            }
            const v = variantMap[btn.style ?? 'primary'] ?? 'primary'
            return (
              <Button
                key={btn.id}
                variant={v}
                size="sm"
                className="h-8 text-xs"
                data-testid={`interactive-card-btn-${btn.id}`}
                onClick={() => handleButtonClick(btn)}
              >
                {btn.label}
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )

  const wrapperBase = 'rounded-lg border border-border bg-surface p-4 transition-colors select-none'

  if (data.click_url && !isSubmitted) {
    return (
      <a
        href={data.click_url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${wrapperBase} hover:border-primary/50 cursor-pointer block`}
        title={t('interactive_card.click_hint')}
        onClick={e => e.stopPropagation()}
      >
        {CardBody}
      </a>
    )
  }

  return <div className={wrapperBase}>{CardBody}</div>
}
