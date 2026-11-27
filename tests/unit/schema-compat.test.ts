import { describe, expect, it } from 'vitest'
import { isAdditiveSchemaUnavailable } from '@/lib/db/schema-compat'

describe('additive schema compatibility guard', () => {
  it('recognizes only missing target relations and columns through wrapped causes', () => {
    expect(isAdditiveSchemaUnavailable({ code: '42P01' })).toBe(true)
    expect(isAdditiveSchemaUnavailable({ cause: { code: '42703' } })).toBe(true)
    expect(isAdditiveSchemaUnavailable(new Error('column "case_entity_id" does not exist'))).toBe(true)
    expect(isAdditiveSchemaUnavailable({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isAdditiveSchemaUnavailable(new Error('connection timeout'))).toBe(false)
  })
})
