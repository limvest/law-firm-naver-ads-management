import type { AdApi } from '@/lib/engine/register-run'
import { SAMPLEONE_SEARCH_CAMPAIGN_NAME } from './bulk-search-run'

type ApiRow = Record<string, unknown>

export const SAMPLEONE_AD_TIME_ZONE = 'Asia/Seoul'
export const SAMPLEONE_AD_START_HOUR = 8
export const SAMPLEONE_AD_END_HOUR = 22

function idFrom(row: ApiRow | undefined, key: string): string | null {
  const value = row?.[key]
  return typeof value === 'string' && value ? value : null
}

export function shouldSampleoneAdsRun(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAMPLEONE_AD_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = parts.find((part) => part.type === 'weekday')?.value
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  return weekday !== 'Sat'
    && weekday !== 'Sun'
    && Number.isInteger(hour)
    && hour >= SAMPLEONE_AD_START_HOUR
    && hour < SAMPLEONE_AD_END_HOUR
}

export async function enforceSampleoneAdHours(
  api: AdApi,
  now = new Date(),
  paceMs = 150,
): Promise<{ active: boolean; groups: number; changed: number }> {
  const campaigns = await api.request<ApiRow[]>('GET', '/ncc/campaigns')
  const campaign = Array.isArray(campaigns)
    ? campaigns.find((row) => row.name === SAMPLEONE_SEARCH_CAMPAIGN_NAME && row.status !== 'DELETED')
    : undefined
  const campaignId = idFrom(campaign, 'nccCampaignId')
  if (!campaignId) throw new Error(`${SAMPLEONE_SEARCH_CAMPAIGN_NAME} 기존 캠페인을 찾을 수 없습니다.`)

  const rows = await api.request<ApiRow[]>('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } })
  const groups = Array.isArray(rows) ? rows.filter((row) => row.status !== 'DELETED') : []
  if (!groups.length) throw new Error(`${SAMPLEONE_SEARCH_CAMPAIGN_NAME}의 활성 광고그룹을 찾을 수 없습니다.`)

  const active = shouldSampleoneAdsRun(now)
  const desiredLock = !active
  let changed = 0
  for (const group of groups) {
    if (group.userLock === desiredLock) continue
    const groupId = idFrom(group, 'nccAdgroupId')
    if (!groupId) throw new Error(`${String(group.name ?? 'unknown')} 광고그룹 ID를 확인할 수 없습니다.`)
    await api.request<ApiRow>('PUT', `/ncc/adgroups/${groupId}`, {
      query: { fields: 'userLock' },
      body: { ...group, userLock: desiredLock },
    })
    changed++
    if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs))
  }

  const verifiedRows = await api.request<ApiRow[]>('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } })
  const mismatches = (Array.isArray(verifiedRows) ? verifiedRows : [])
    .filter((row) => row.status !== 'DELETED')
    .filter((row) => row.userLock !== desiredLock)
  if (mismatches.length) throw new Error(`광고시간 적용 재검증 실패: ${mismatches.length}개 그룹 불일치`)
  return { active, groups: groups.length, changed }
}
