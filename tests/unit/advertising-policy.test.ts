import { describe, expect, it } from 'vitest'
import {
  decideNaverAdPacing,
  evaluateNaverAdAction,
  isNaverAdActionAllowed,
  isNaverAdCaseAllowed,
  normalizeNaverAdPolicy,
} from '@/domains/advertising'

const basePolicy = {
  monthlyCeiling: 100_000,
  dailyCeiling: 10_000,
  bidCeiling: 1_000,
  allowedCaseIds: ['case-1'],
  allowedActions: ['register', 'activate', 'increase_bid', 'pause'],
} as const

const spendRequest = {
  caseId: 'case-1',
  monthlySpend: 20_000,
  dailySpend: 2_000,
  requestedMonthlyBudget: 100_000,
  requestedDailyBudget: 5_000,
  requestedBid: 500,
} as const

describe('Naver customer ad policy', () => {
  it('normalizes schema aliases and defaults to dry-run', () => {
    const policy = normalizeNaverAdPolicy({
      monthlyBudget: 100_000,
      dailyBudget: 10_000,
      bidLimit: 1_000,
      allowedCaseEntityIds: ['case-1'],
      allowedActions: ['registration', 'deactivate'],
    })

    expect(policy).toMatchObject({
      monthlyCeiling: 100_000,
      dailyCeiling: 10_000,
      bidCeiling: 1_000,
      allowedCaseIds: ['case-1'],
      allowedActions: ['register', 'pause'],
      dryRun: true,
    })
  })

  it('requires explicit scope and action approval', () => {
    expect(isNaverAdCaseAllowed(basePolicy, 'case-1')).toBe(true)
    expect(isNaverAdCaseAllowed(basePolicy, 'case-2')).toBe(false)
    expect(isNaverAdActionAllowed(basePolicy, 'register', 'case-1')).toBe(true)
    expect(isNaverAdActionAllowed(basePolicy, 'decrease_bid', 'case-1')).toBe(false)
    expect(isNaverAdActionAllowed({ ...basePolicy, allowedCaseIds: [] }, 'pause', 'case-1')).toBe(false)
    expect(isNaverAdActionAllowed({
      allowedCaseIds: ['case-1'],
      allowedActions: ['register'],
    }, 'register', 'case-1')).toBe(false)
  })

  it('does not authorize a spend-causing action in default dry-run mode', () => {
    const result = evaluateNaverAdAction(basePolicy, {
      action: 'register',
      ...spendRequest,
    })

    expect(result.approved).toBe(true)
    expect(result.decision).toBe('dry_run')
    expect(result.allowed).toBe(false)
    expect(result.wouldExecute).toBe(false)
    expect(result.reasonCodes).toContain('dry_run')
  })

  it('hard-denies an unapproved case, action, and every spend ceiling breach', () => {
    const unapprovedCase = evaluateNaverAdAction(
      { ...basePolicy, dryRun: false },
      { action: 'activate', ...spendRequest, caseId: 'case-2' },
    )
    expect(unapprovedCase.allowed).toBe(false)
    expect(unapprovedCase.reasonCodes).toContain('case_not_allowed')

    const monthly = evaluateNaverAdAction(
      { ...basePolicy, dryRun: false },
      { action: 'activate', ...spendRequest, monthlySpend: 100_000 },
    )
    expect(monthly.allowed).toBe(false)
    expect(monthly.reasonCodes).toContain('monthly_ceiling_exceeded')

    const daily = evaluateNaverAdAction(
      { ...basePolicy, dryRun: false },
      { action: 'activate', ...spendRequest, dailySpend: 9_500, additionalSpend: 501 },
    )
    expect(daily.allowed).toBe(false)
    expect(daily.reasonCodes).toContain('projected_daily_ceiling_exceeded')

    const bid = evaluateNaverAdAction(
      { ...basePolicy, dryRun: false },
      { action: 'increase_bid', ...spendRequest, currentBid: 500, requestedBid: 1_001 },
    )
    expect(bid.allowed).toBe(false)
    expect(bid.reasonCodes).toContain('bid_ceiling_exceeded')
  })

  it('requires all explicit bounds and request budgets for registration/activation', () => {
    const missing = evaluateNaverAdAction(
      {
        allowedCaseIds: ['case-1'],
        allowedActions: ['register'],
        dryRun: false,
      },
      {
        action: 'register',
        caseId: 'case-1',
        monthlySpend: 0,
        dailySpend: 0,
        requestedBid: 100,
      },
    )

    expect(missing.allowed).toBe(false)
    expect(missing.reasonCodes).toEqual(expect.arrayContaining([
      'missing_monthly_ceiling',
      'missing_daily_ceiling',
      'missing_bid_ceiling',
      'missing_requested_monthly_budget',
      'missing_requested_daily_budget',
    ]))
  })

  it('allows an in-bounds live bid increase only when explicitly enabled', () => {
    const result = evaluateNaverAdAction(
      { ...basePolicy, dryRun: false },
      {
        action: 'increase_bid',
        ...spendRequest,
        currentBid: 400,
        requestedBid: 500,
      },
    )

    expect(result).toMatchObject({
      approved: true,
      allowed: true,
      executable: true,
      decision: 'allow',
    })
  })

  it('keeps dry-run dominant over a contradictory live mode', () => {
    const result = evaluateNaverAdAction(
      { ...basePolicy, dryRun: true, mode: 'live' },
      { action: 'pause', caseId: 'case-1' },
    )

    expect(result.decision).toBe('dry_run')
    expect(result.allowed).toBe(false)
  })
})

describe('Naver budget pacing', () => {
  it('returns a deterministic hard pause at either spend ceiling', () => {
    const input = {
      caseId: 'case-1',
      reviewStatus: 'approved',
      monthlySpend: 80_000,
      dailySpend: 10_000,
      performanceStatus: 'healthy',
    } as const

    const first = decideNaverAdPacing(basePolicy, input)
    const second = decideNaverAdPacing(basePolicy, input)
    expect(first).toEqual(second)
    expect(first.decision).toBe('pause')
    expect(first.shouldPause).toBe(true)
    expect(first.reasonCodes).toContain('daily_ceiling_exceeded')
    expect(first.pauseExecutable).toBe(false)
  })

  it('recommends pause for rejected review or poor performance, and holds unknown data', () => {
    const rejected = decideNaverAdPacing({ ...basePolicy, dryRun: false }, {
      caseId: 'case-1', reviewStatus: 'rejected', monthlySpend: 1_000, dailySpend: 100,
      performanceStatus: 'healthy',
    })
    expect(rejected.decision).toBe('pause')
    expect(rejected.reasonCodes).toContain('review_rejected')
    expect(rejected.pauseExecutable).toBe(true)

    const poor = decideNaverAdPacing(basePolicy, {
      caseId: 'case-1', reviewStatus: 'approved', monthlySpend: 1_000, dailySpend: 100,
      performanceStatus: 'poor',
    })
    expect(poor.decision).toBe('recommend_pause')
    expect(poor.shouldRecommendPause).toBe(true)

    const unknown = decideNaverAdPacing(basePolicy, {
      caseId: 'case-1', reviewStatus: 'unknown', monthlySpend: 1_000, dailySpend: 100,
    })
    expect(unknown.decision).toBe('hold')
    expect(unknown.reasonCodes).toContain('review_unknown')
    expect(unknown.reasonCodes).toContain('performance_unknown')
  })

  it('derives poor performance from approved thresholds without side effects', () => {
    const result = decideNaverAdPacing({
      ...basePolicy,
      minCtr: 0.02,
      minClicks: 10,
    }, {
      caseId: 'case-1', reviewStatus: 'approved', monthlySpend: 1_000, dailySpend: 100,
      performance: { clicks: 20, ctr: 0.01 },
    })

    expect(result.performanceStatus).toBe('poor')
    expect(result.decision).toBe('recommend_pause')
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'performance_poor',
      'performance_ctr_below_minimum',
    ]))
  })
})
