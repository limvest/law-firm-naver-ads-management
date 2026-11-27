import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { operationAlerts } from '@/lib/db/schema'

export type OperatorAlertDecision = 'acknowledged' | 'resolved'

export async function decideOperationAlert(
  db: Db,
  input: { id: string; decision: OperatorAlertDecision; now?: Date },
): Promise<typeof operationAlerts.$inferSelect | null> {
  const id = input.id.trim()
  if (!id) throw new TypeError('alert id must not be empty')
  if (!['acknowledged', 'resolved'].includes(input.decision)) throw new TypeError('invalid alert decision')
  const now = input.now ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('decision time must be valid')
  const allowedCurrentStates = input.decision === 'acknowledged'
    ? ['open']
    : ['open', 'acknowledged']
  const [row] = await db.update(operationAlerts).set({
    status: input.decision,
    resolvedAt: input.decision === 'resolved' ? now : null,
  }).where(and(
    eq(operationAlerts.id, id),
    inArray(operationAlerts.status, allowedCurrentStates),
  )).returning()
  return row ?? null
}
