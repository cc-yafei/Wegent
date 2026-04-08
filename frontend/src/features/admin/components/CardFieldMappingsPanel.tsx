// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { PlusIcon, TrashIcon, PencilIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  adminApis,
  type CardPollFieldMapping,
  type CardPollFieldMappingsConfig,
} from '@/apis/admin'

interface MappingFormData {
  name: string
  description: string
  url_pattern: string
  field_mapping_json: string
  status_value_mapping_json: string
}

const DEFAULT_FIELD_MAPPING_JSON = JSON.stringify(
  { status: 'data.state', progress: 'data.pct', status_text: 'data.message' },
  null,
  2
)

const DEFAULT_STATUS_VALUE_MAPPING_JSON = JSON.stringify(
  {
    completed: ['done', 'success', 'finished'],
    failed: ['failed', 'error', 'timeout'],
    polling: ['running', 'processing', 'in_progress'],
  },
  null,
  2
)

function emptyFormData(): MappingFormData {
  return {
    name: '',
    description: '',
    url_pattern: '',
    field_mapping_json: DEFAULT_FIELD_MAPPING_JSON,
    status_value_mapping_json: DEFAULT_STATUS_VALUE_MAPPING_JSON,
  }
}

function mappingToForm(m: CardPollFieldMapping): MappingFormData {
  return {
    name: m.name,
    description: m.description ?? '',
    url_pattern: m.url_pattern,
    field_mapping_json: JSON.stringify(m.field_mapping, null, 2),
    status_value_mapping_json: JSON.stringify(m.status_value_mapping, null, 2),
  }
}

function parseJson(s: string): [Record<string, unknown> | null, string | null] {
  try {
    return [JSON.parse(s), null]
  } catch {
    return [null, 'invalid json']
  }
}

export function CardFieldMappingsPanel() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()

  const [config, setConfig] = useState<CardPollFieldMappingsConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // Dialog state
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [formData, setFormData] = useState<MappingFormData>(emptyFormData())
  const [formErrors, setFormErrors] = useState<Partial<MappingFormData>>({})

  // Delete dialog state
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const cfg = await adminApis.getCardFieldMappings()
      setConfig(cfg)
    } catch {
      toast({ title: t('card_field_mappings.load_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    load()
  }, [load])

  const validate = (data: MappingFormData): boolean => {
    const errors: Partial<MappingFormData> = {}
    if (!data.name.trim()) errors.name = t('card_field_mappings.name_required')
    if (!data.url_pattern.trim()) errors.url_pattern = t('card_field_mappings.url_pattern_required')

    const [, fieldErr] = parseJson(data.field_mapping_json)
    if (fieldErr) errors.field_mapping_json = t('card_field_mappings.json_invalid')

    const [, statusErr] = parseJson(data.status_value_mapping_json)
    if (statusErr) errors.status_value_mapping_json = t('card_field_mappings.json_invalid')

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSave = async () => {
    if (!config || !validate(formData)) return

    const [fieldMapping] = parseJson(formData.field_mapping_json)
    const [statusMapping] = parseJson(formData.status_value_mapping_json)

    const newMapping: CardPollFieldMapping = {
      name: formData.name.trim(),
      description: formData.description.trim() || undefined,
      url_pattern: formData.url_pattern.trim(),
      field_mapping: (fieldMapping as Record<string, string>) ?? {},
      status_value_mapping: (statusMapping as Record<string, string[]>) ?? {},
    }

    const updatedMappings = [...config.mappings]
    if (editingIndex !== null) {
      updatedMappings[editingIndex] = newMapping
    } else {
      updatedMappings.push(newMapping)
    }

    setIsSaving(true)
    try {
      const updated = await adminApis.updateCardFieldMappings({ mappings: updatedMappings })
      setConfig(updated)
      setIsDialogOpen(false)
      toast({ title: t('card_field_mappings.save_success') })
    } catch {
      toast({ title: t('card_field_mappings.save_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!config || deleteIndex === null) return
    const updatedMappings = config.mappings.filter((_, i) => i !== deleteIndex)
    setIsSaving(true)
    try {
      const updated = await adminApis.updateCardFieldMappings({ mappings: updatedMappings })
      setConfig(updated)
      setDeleteIndex(null)
      toast({ title: t('card_field_mappings.save_success') })
    } catch {
      toast({ title: t('card_field_mappings.save_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const openAdd = () => {
    setEditingIndex(null)
    setFormData(emptyFormData())
    setFormErrors({})
    setIsDialogOpen(true)
  }

  const openEdit = (index: number) => {
    const m = config!.mappings[index]
    setEditingIndex(index)
    setFormData(mappingToForm(m))
    setFormErrors({})
    setIsDialogOpen(true)
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">{t('system_config.loading')}</span>
      </div>
    )
  }

  const mappings = config?.mappings ?? []

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t('card_field_mappings.title')}
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            {t('card_field_mappings.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openAdd} data-testid="add-card-mapping-button">
          <PlusIcon className="h-4 w-4 mr-1" />
          {t('card_field_mappings.add')}
        </Button>
      </div>

      {/* Mapping list */}
      {mappings.length === 0 ? (
        <Card className="p-4 text-center">
          <p className="text-sm text-text-muted">{t('card_field_mappings.no_mappings')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {mappings.map((m, i) => (
            <Card key={i} className="p-3 flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{m.name}</p>
                {m.description && (
                  <p className="text-xs text-text-muted mt-0.5 truncate">{m.description}</p>
                )}
                <code className="text-[10px] text-text-secondary font-mono mt-1 block truncate">
                  {m.url_pattern}
                </code>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => openEdit(i)}
                  data-testid={`edit-card-mapping-${i}`}
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => setDeleteIndex(i)}
                  data-testid={`delete-card-mapping-${i}`}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? t('card_field_mappings.edit') : t('card_field_mappings.add')}
            </DialogTitle>
            <DialogDescription>{t('system_config.dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">{t('card_field_mappings.name')}</Label>
              <Input
                className="mt-1 text-sm"
                placeholder={t('card_field_mappings.name_placeholder')}
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                data-testid="card-mapping-name-input"
              />
              {formErrors.name && (
                <p className="text-xs text-destructive mt-0.5">{formErrors.name}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t('card_field_mappings.description_label')}</Label>
              <Input
                className="mt-1 text-sm"
                placeholder={t('card_field_mappings.description_placeholder')}
                value={formData.description}
                onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">{t('card_field_mappings.url_pattern')}</Label>
              <Input
                className="mt-1 text-sm font-mono"
                placeholder={t('card_field_mappings.url_pattern_placeholder')}
                value={formData.url_pattern}
                onChange={e => setFormData(prev => ({ ...prev, url_pattern: e.target.value }))}
                data-testid="card-mapping-url-pattern-input"
              />
              {formErrors.url_pattern && (
                <p className="text-xs text-destructive mt-0.5">{formErrors.url_pattern}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t('card_field_mappings.field_mapping')}</Label>
              <Textarea
                className="mt-1 text-xs font-mono h-24"
                placeholder={t('card_field_mappings.field_mapping_placeholder')}
                value={formData.field_mapping_json}
                onChange={e =>
                  setFormData(prev => ({ ...prev, field_mapping_json: e.target.value }))
                }
              />
              {formErrors.field_mapping_json && (
                <p className="text-xs text-destructive mt-0.5">{formErrors.field_mapping_json}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t('card_field_mappings.status_value_mapping')}</Label>
              <Textarea
                className="mt-1 text-xs font-mono h-24"
                placeholder={t('card_field_mappings.status_value_mapping_placeholder')}
                value={formData.status_value_mapping_json}
                onChange={e =>
                  setFormData(prev => ({
                    ...prev,
                    status_value_mapping_json: e.target.value,
                  }))
                }
              />
              {formErrors.status_value_mapping_json && (
                <p className="text-xs text-destructive mt-0.5">
                  {formErrors.status_value_mapping_json}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteIndex !== null} onOpenChange={open => !open && setDeleteIndex(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('card_field_mappings.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('card_field_mappings.delete_message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
