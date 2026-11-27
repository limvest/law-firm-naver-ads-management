import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { provisionFirm, setFirmPublicReady } from '@/lib/engine/provision'
import { clearFirmCache } from '@/lib/engine/firms'
import { isSiteTemplateKey } from '@/lib/site-templates'
import { requeueJob } from '@/platform/jobs/postgres-queue'
import { decideOperationAlert } from '@/domains/operations/operator-mutations'
import { decideApprovalTask } from '@/domains/operations/approvals'
import {
  PRODUCT_LEAD_PACKAGES,
  PRODUCT_LEAD_STAGES,
  normalizeGtmEvidenceNote,
  requiresGtmEvidenceNote,
  setProductLeadFollowUp,
  transitionProductLeadStage,
  type GtmPipelineStage,
  type ProductLeadPackage,
} from '@/domains/gtm'
import { resolvePlatformLeadFirm } from '@/lib/engine/public-firm'
import { encryptPII } from '@/lib/crypto'
import { leads, productLeadProfiles, productLeadStageHistory, sourceCollectionRequests } from '@/lib/db/schema'
import { reviewSourceRequest } from '@/lib/dashboard/source-requests'
import { createCollectorSource, ensureCollectorSource, setCollectorSourceEnabled } from '@/domains/intelligence/source-registry'
import { analyzePendingCollectorSources } from '@/domains/intelligence/source-analyzer'
import { runDatabaseReviewAgent } from '@/domains/intelligence/database-review-agent'
import { decideAgentActionProposal } from '@/domains/intelligence/agent-action-approval'
import { finishAgentExecution, startAgentExecution } from '@/lib/dashboard/agent-executions'
import { approveRequestedSource, grantSourceToFirm, setFirmSourceGrantStatus } from '@/lib/dashboard/firm-source-grants'
import { eq } from 'drizzle-orm'
import { getFirmActivationChecklist } from '@/domains/tenancy/activation'
import { cookies } from 'next/headers'
import { ADMIN_SESSION_COOKIE, validAdminSession } from '@/lib/admin-auth'

async function hasAdminSession(): Promise<boolean> {
  const secret = process.env.ADMIN_TOKEN
  const session = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value
  return validAdminSession(session, secret)
}

export async function provisionFirmFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const value = (name: string) => String(formData.get(name) ?? '').trim()
  const siteTemplate = value('siteTemplate')
  const slug = value('slug')
  const domain = value('domain') || null
  if (!isSiteTemplateKey(siteTemplate)) {
    redirect('/operator?section=firms&error=template')
  }
  let enrolledKeywords = 0
  try {
    const list = (name: string) => value(name).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
    const lawyerName = value('lawyerName') || value('adLawyerName')
    const result = await provisionFirm(getDb(), {
      slug,
      name: value('name'),
      adLawyerName: value('adLawyerName'),
      phone: value('phone'),
      phoneIntl: value('phoneIntl'),
      address: value('address'),
      addressRegion: value('addressRegion'),
      addressLocality: value('addressLocality'),
      kakaoUrl: value('kakaoUrl') || null,
      domain,
      status: 'pilot',
      lawyers: [{
        name: lawyerName,
        title: value('lawyerTitle') || '대표변호사',
        badges: list('lawyerBadges'),
        photo: value('lawyerPhoto') || null,
        bio: value('lawyerBio') || undefined,
        career: list('lawyerCareer'),
        practiceAreas: list('practiceAreas'),
      }],
      wordmark: value('wordmark') || value('name'),
      siteTemplate,
      profileIntro: value('profileIntro'),
      officeHistory: list('officeHistory'),
      adConfig: null,
      loginId: value('loginId'),
      password: value('password'),
    })
    enrolledKeywords = result.enrolledKeywords
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    const reason = message.startsWith('invalid provision fields:')
      ? 'provision-input'
      : message.startsWith('firm id collision:') || code === '23505'
        ? 'provision-conflict'
        : 'provision-failed'
    console.error('operator.provision_firm.failed', { slug, reason, error: message })
    redirect(`/operator?section=firms&error=${reason}`)
  }
  revalidatePath('/operator')
  redirect(`/operator?section=firms&created=${encodeURIComponent(slug)}&enrolled=${enrolledKeywords}`)
}

export async function setFirmPublicReadyFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const firmId = Number(formData.get('firmId'))
  const ready = String(formData.get('ready')) === 'true'
  if (!Number.isInteger(firmId) || firmId <= 0) redirect('/operator?section=firms&error=publish')

  let firm: Awaited<ReturnType<typeof setFirmPublicReady>> | null = null
  const db = getDb()
  if (ready) {
    let complete = false
    try { complete = (await getFirmActivationChecklist(db, firmId))?.complete ?? false } catch { redirect('/operator?section=firms&error=activation-unavailable') }
    if (!complete) redirect('/operator?section=firms&error=activation-incomplete')
  }
  try {
    firm = await setFirmPublicReady(db, firmId, ready)
    clearFirmCache()
    revalidatePath('/')
    revalidatePath('/operator')
    revalidatePath('/f', 'layout')
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error
    redirect('/operator?section=firms&error=publish')
  }

  if (!firm) redirect('/operator?section=firms&error=publish')
  redirect(`/operator?section=firms&updated=${encodeURIComponent(firm.slug)}`)
}

function isRedirectError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'digest' in error)
}

export async function createProductTargetFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const value = (name: string) => String(formData.get(name) ?? '').trim()
  const officeName = value('officeName')
  const phone = value('phone')
  const packageInterest = value('packageInterest') as ProductLeadPackage
  let evidenceNote: string | null
  try {
    evidenceNote = normalizeGtmEvidenceNote(value('evidenceNote'))
  } catch {
    redirect('/operator?action=gtm-invalid')
  }
  if (!officeName
    || !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)
    || !(PRODUCT_LEAD_PACKAGES as readonly string[]).includes(packageInterest)
    || !evidenceNote) {
    redirect('/operator?action=gtm-invalid')
  }

  try {
    const db = getDb()
    const platform = await resolvePlatformLeadFirm(db)
    await db.transaction(async (tx) => {
      const [lead] = await tx.insert(leads).values({
        firmId: platform.id,
        vertical: 'product',
        slug: 'operator-target',
        nameEnc: encryptPII(officeName),
        phoneEnc: encryptPII(phone),
        detailEnc: value('contactName') ? encryptPII(JSON.stringify({ contactName: value('contactName') })) : null,
        status: 'new',
        priority: 'normal',
      }).returning({ id: leads.id })
      if (!lead) throw new Error('target lead insert returned no row')
      await tx.insert(productLeadProfiles).values({
        leadId: lead.id,
        firmId: platform.id,
        packageInterest,
        managedOps: value('managedOps') === 'true' || packageInterest === 'managed_ops',
        budgetBand: value('budgetBand') || null,
        teamSize: value('teamSize') || null,
        repeatFraudMatters: value('repeatFraudMatters') || null,
        ownDomain: value('ownDomain') || null,
        naverAccount: value('naverAccount') || null,
        responseOwner: value('responseOwner') || null,
        outcomeTracking: value('outcomeTracking') || null,
        stage: 'targeted',
      })
      await tx.insert(productLeadStageHistory).values({
        leadId: lead.id,
        firmId: platform.id,
        fromStage: null,
        toStage: 'targeted',
        evidenceNote,
        actor: 'operator-console',
      })
    })
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect('/operator?action=gtm-failed')
  }
  revalidatePath('/operator')
  redirect('/operator?action=gtm-created')
}

export async function transitionProductLeadFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const leadId = String(formData.get('leadId') ?? '').trim()
  const toStage = String(formData.get('toStage') ?? '') as GtmPipelineStage
  const lostReason = String(formData.get('lostReason') ?? '').trim()
  let evidenceNote: string | null
  try {
    evidenceNote = normalizeGtmEvidenceNote(String(formData.get('evidenceNote') ?? ''))
  } catch {
    redirect('/operator?action=gtm-invalid')
  }
  if (!leadId || !(PRODUCT_LEAD_STAGES as readonly string[]).includes(toStage)) {
    redirect('/operator?action=gtm-invalid')
  }
  if (requiresGtmEvidenceNote(toStage) && !evidenceNote) {
    redirect('/operator?action=gtm-evidence-required')
  }
  try {
    const db = getDb()
    const platform = await resolvePlatformLeadFirm(db)
    const updated = await transitionProductLeadStage(db, {
      firmId: platform.id,
      leadId,
      toStage,
      lostReason: lostReason || null,
      evidenceNote,
      actor: 'operator-console',
    })
    if (!updated) redirect('/operator?action=gtm-not-found')
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect('/operator?action=gtm-invalid-transition')
  }
  revalidatePath('/operator')
  redirect('/operator?action=gtm-updated')
}

export async function setProductLeadFollowUpFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const leadId = String(formData.get('leadId') ?? '').trim()
  const followUpAtLocal = String(formData.get('followUpAt') ?? '').trim()
  const followUpAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(followUpAtLocal)
    ? new Date(`${followUpAtLocal}:00+09:00`)
    : followUpAtLocal || null
  if (!leadId) redirect('/operator?action=gtm-invalid')
  try {
    const db = getDb()
    const platform = await resolvePlatformLeadFirm(db)
    const updated = await setProductLeadFollowUp(db, {
      firmId: platform.id,
      leadId,
      followUpAt,
    })
    if (!updated) redirect('/operator?action=gtm-not-found')
  } catch (error) {
    if (isRedirectError(error)) throw error
    redirect('/operator?action=gtm-invalid')
  }
  revalidatePath('/operator')
  redirect('/operator?action=gtm-followup-updated')
}

export async function requeueJobFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const jobId = String(formData.get('jobId') ?? '').trim()
  if (!jobId) redirect('/operator?action=job-not-found')
  const row = await requeueJob(getDb(), { id: jobId })
  revalidatePath('/operator')
  redirect(`/operator?action=${row ? 'job-requeued' : 'job-not-found'}`)
}

export async function decideAlertFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const alertId = String(formData.get('alertId') ?? '').trim()
  const rawDecision = String(formData.get('decision') ?? '')
  const decision = rawDecision === 'resolved' ? 'resolved' : rawDecision === 'acknowledged' ? 'acknowledged' : null
  if (!alertId || !decision) redirect('/operator?action=alert-not-found')
  const row = await decideOperationAlert(getDb(), { id: alertId, decision })
  revalidatePath('/operator')
  redirect(`/operator?action=${row ? `alert-${decision}` : 'alert-not-found'}`)
}

export async function decideCaseApprovalFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const taskId = String(formData.get('taskId') ?? '').trim()
  const rawDecision = String(formData.get('decision') ?? '')
  const decision = rawDecision === 'approve' || rawDecision === 'reject' || rawDecision === 'block'
    ? rawDecision
    : null
  const reason = String(formData.get('reason') ?? '').trim()
  if (!taskId || !decision || !reason) redirect('/operator?action=approval-invalid')
  try {
    await decideApprovalTask(getDb(), {
      taskId,
      decision,
      actorType: 'operator',
      actorId: 'operator-console',
      reason,
    })
  } catch {
    redirect('/operator?action=approval-blocked')
  }
  revalidatePath('/operator')
  redirect(`/operator?action=case-${decision === 'approve' ? 'approved' : decision === 'block' ? 'blocked' : 'rejected'}`)
}

export async function reviewSourceRequestFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const id = String(formData.get('requestId') ?? '').trim()
  const rawStatus = String(formData.get('status') ?? '')
  const status = rawStatus === 'registered' || rawStatus === 'rejected' ? rawStatus : null
  if (!id || !status) redirect('/operator?section=sources&action=source-request-invalid')
  const db = getDb()
  let updated = false
  if (status === 'registered') {
    const request = (await db.select({
      id: sourceCollectionRequests.id,
      sourceUrl: sourceCollectionRequests.sourceUrl,
      status: sourceCollectionRequests.status,
    }).from(sourceCollectionRequests).where(eq(sourceCollectionRequests.id, id)).limit(1))[0]
    if (request?.status === 'pending') {
      let sourceName = '법무법인 요청 수집소스'
      try { sourceName = `${new URL(request.sourceUrl).hostname} 수집소스` } catch { /* ensureCollectorSource가 invalid 처리 */ }
      const source = await ensureCollectorSource(db, { name: sourceName, url: request.sourceUrl })
      if (source.result !== 'invalid') {
        updated = await approveRequestedSource(db, {
          requestId: request.id,
          sourceId: source.sourceId,
          operatorNote: String(formData.get('operatorNote') ?? '').trim() || null,
        })
      }
    }
  } else {
    updated = await reviewSourceRequest(db, {
      id,
      status,
      operatorNote: formData.get('operatorNote'),
    })
  }
  revalidatePath('/operator')
  redirect(`/operator?section=sources&action=${updated ? `source-request-${status}` : 'source-request-stale'}`)
}

export async function grantCollectorSourceFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const firmId = Number(formData.get('firmId'))
  const sourceId = String(formData.get('sourceId') ?? '').trim()
  const updated = await grantSourceToFirm(getDb(), { firmId, sourceId })
  revalidatePath('/operator')
  redirect(`/operator?section=sources&action=${updated ? 'source-granted' : 'source-grant-invalid'}`)
}

export async function setFirmSourceGrantStatusFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const firmId = Number(formData.get('firmId'))
  const sourceId = String(formData.get('sourceId') ?? '').trim()
  const rawStatus = String(formData.get('status') ?? '')
  const status = rawStatus === 'active' || rawStatus === 'paused' || rawStatus === 'revoked' ? rawStatus : null
  const updated = status ? await setFirmSourceGrantStatus(getDb(), { firmId, sourceId, status }) : false
  revalidatePath('/operator')
  redirect(`/operator?section=sources&action=${updated ? `source-grant-${status}` : 'source-grant-invalid'}`)
}

export async function createCollectorSourceFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  try {
    const result = await createCollectorSource(getDb(), {
      name: formData.get('name'),
      url: formData.get('url'),
    })
    revalidatePath('/operator')
    redirect(`/operator?section=sources&action=collector-${result}`)
  } catch (error) {
    if (isRedirectError(error)) throw error
    console.error('operator.collector_source.create_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    redirect('/operator?section=sources&action=collector-failed')
  }
}

export async function toggleCollectorSourceFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const sourceKey = String(formData.get('sourceKey') ?? '').trim()
  const enabled = String(formData.get('enabled')) === 'true'
  try {
    const updated = await setCollectorSourceEnabled(getDb(), sourceKey, enabled)
    revalidatePath('/operator')
    redirect(`/operator?section=sources&action=${updated ? `collector-${enabled ? 'enabled' : 'disabled'}` : 'collector-not-found'}`)
  } catch (error) {
    if (isRedirectError(error)) throw error
    console.error('operator.collector_source.toggle_failed', {
      sourceKey,
      error: error instanceof Error ? error.message : String(error),
    })
    redirect('/operator?section=sources&action=collector-failed')
  }
}

export async function runParserBuilderFromConsole(): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const db = getDb()
  let executionId: string | null = null
  try {
    executionId = await startAgentExecution(db, { agentType: 'parser_builder', trigger: 'operator-console' })
    const result = await analyzePendingCollectorSources(db, { limit: 20 })
    await finishAgentExecution(db, {
      id: executionId,
      status: result.needsReview ? 'warning' : 'completed',
      report: {
        summary: result.analyzed
          ? `신규 URL ${result.analyzed}건의 구조 분석을 마쳤습니다.`
          : '분석을 기다리는 신규 URL이 없습니다.',
        counts: { analyzed: result.analyzed, ready: result.ready, needsReview: result.needsReview },
        details: [
          `파서 등록 ${result.ready}건`,
          `검토 필요 ${result.needsReview}건`,
        ],
        findings: result.needsReview ? [{
          code: 'parser_needs_review', severity: 'warning', count: result.needsReview,
          message: `자동 검증을 통과하지 못한 소스가 ${result.needsReview}개 있습니다.`,
        }] : [],
      },
      recommendations: result.needsReview
        ? ['검토 필요 소스의 공개 URL과 반복 목록 구조를 확인한 뒤 다시 분석합니다.']
        : ['등록된 파서는 다음 수집 실행부터 자동으로 사용됩니다.'],
    })
    revalidatePath('/operator')
    redirect('/operator?section=agents&action=parser-completed#operator-content')
  } catch (error) {
    if (isRedirectError(error)) throw error
    if (executionId) {
      await finishAgentExecution(db, {
        id: executionId,
        status: 'failed',
        report: {
          summary: '파서 생성 실행을 완료하지 못했습니다.', counts: {},
          details: [error instanceof Error ? error.message : String(error)],
          findings: [{ code: 'parser_execution_failed', severity: 'critical', count: 1, message: '파서 생성 실행 중 오류가 발생했습니다.' }],
        },
        recommendations: ['기존 파서는 유지됩니다. 오류 내용을 확인한 뒤 실패 소스만 다시 분석합니다.'],
      }).catch(() => false)
    }
    console.error('operator.parser_builder.failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    redirect('/operator?section=agents&action=parser-failed#operator-content')
  }
}

export async function runDatabaseReviewFromConsole(): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const db = getDb()
  let executionId: string | null = null
  try {
    executionId = await startAgentExecution(db, { agentType: 'database_review', trigger: 'operator-console' })
    const result = await runDatabaseReviewAgent(db, { force: true, reviewRunId: executionId })
    const findings = result.decision.findings
    const total = findings.reduce((sum, finding) => sum + finding.count, 0)
    await finishAgentExecution(db, {
      id: executionId,
      status: findings.length ? 'warning' : 'completed',
      report: {
        summary: findings.length
          ? `${findings.length}종, 총 ${total}건의 이상 후보를 확인했습니다.`
          : '현재 운영 DB에서 조치가 필요한 이상을 찾지 못했습니다.',
        counts: { findingTypes: findings.length, affectedRows: total, proposalsCreated: result.proposalsCreated },
        details: [...findings.map((finding) => finding.message), `인간 승인 대기 조치 ${result.proposalsCreated}건`],
        findings: findings.map((finding) => ({ ...finding })),
      },
      recommendations: result.report?.recommendation ?? ['현재 상태를 유지하고 다음 수집 결과를 관찰합니다.'],
    })
    revalidatePath('/operator')
    redirect('/operator?section=agents&action=review-completed#operator-content')
  } catch (error) {
    if (isRedirectError(error)) throw error
    if (executionId) {
      await finishAgentExecution(db, {
        id: executionId,
        status: 'failed',
        report: {
          summary: '운영 DB 진단을 완료하지 못했습니다.', counts: {},
          details: [error instanceof Error ? error.message : String(error)],
          findings: [{ code: 'database_review_failed', severity: 'critical', count: 1, message: '읽기 전용 진단 중 오류가 발생했습니다.' }],
        },
        recommendations: ['운영 데이터는 변경되지 않았습니다. 연결 상태를 확인한 뒤 진단을 다시 실행합니다.'],
      }).catch(() => false)
    }
    console.error('operator.database_review.failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    redirect('/operator?section=agents&action=review-failed#operator-content')
  }
}

export async function decideAgentActionProposalFromConsole(formData: FormData): Promise<void> {
  'use server'
  if (!await hasAdminSession()) redirect('/operator/login')
  const proposalId = String(formData.get('proposalId') ?? '').trim()
  const decision = String(formData.get('decision') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()
  if (!proposalId || (decision !== 'approve' && decision !== 'reject') || note.length < 2) {
    redirect('/operator?section=agents&action=agent-action-invalid#operator-content')
  }
  try {
    await decideAgentActionProposal(getDb(), {
      proposalId,
      decision,
      actorId: 'operator-console',
      note,
    })
    revalidatePath('/operator')
    redirect(`/operator?section=agents&action=agent-action-${decision === 'approve' ? 'approved' : 'rejected'}#operator-content`)
  } catch (error) {
    if (isRedirectError(error)) throw error
    console.error('operator.agent_action_decision.failed', {
      proposalId,
      decision,
      error: error instanceof Error ? error.message : String(error),
    })
    redirect('/operator?section=agents&action=agent-action-failed#operator-content')
  }
}
