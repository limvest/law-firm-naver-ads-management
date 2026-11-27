import { describe, expect, it } from 'vitest'
import { firms, operationAlerts } from '@/lib/db/schema'
import { createTestDb } from '../helpers/test-db'
import { decideOperationAlert } from '@/domains/operations/operator-mutations'

describe('operator mutations', () => {
  it('acknowledges and resolves an alert through guarded transitions', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({
      id: 91, slug: 'operator-mutation', name: 'Operator Firm', adLawyerName: 'Lawyer',
      phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: 'Seoul',
      addressRegion: 'Seoul', addressLocality: 'Gangnam',
    })
    const [alert] = await db.insert(operationAlerts).values({
      firmId: 91,
      alertType: 'publication.blocked',
      severity: 'critical',
      message: 'canonical mismatch',
    }).returning()
    const acknowledged = await decideOperationAlert(db, { id: alert.id, decision: 'acknowledged' })
    expect(acknowledged).toMatchObject({ status: 'acknowledged', resolvedAt: null })
    expect(await decideOperationAlert(db, { id: alert.id, decision: 'acknowledged' })).toBeNull()
    const at = new Date('2026-08-10T05:00:00Z')
    const resolved = await decideOperationAlert(db, { id: alert.id, decision: 'resolved', now: at })
    expect(resolved).toMatchObject({ status: 'resolved', resolvedAt: at })
    expect(await decideOperationAlert(db, { id: alert.id, decision: 'resolved' })).toBeNull()
  })
})
