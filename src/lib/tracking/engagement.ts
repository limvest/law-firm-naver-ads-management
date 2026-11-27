export type InterestSignals = {
  activeSeconds: number
  maxScroll: number
  pageViews: number
  lawyerViewed: boolean
  processViewed: boolean
  contactViewed: boolean
  formStarted: boolean
}

/** 행동 비교용 내부 점수이며 수임 가능성이나 개인 성향을 단정하지 않는다. */
export function calculateInterestScore(signals: InterestSignals): number {
  let score = 0
  if (signals.activeSeconds >= 15) score += 5
  if (signals.activeSeconds >= 45) score += 15
  if (signals.activeSeconds >= 90) score += 10
  if (signals.maxScroll >= 50) score += 5
  if (signals.maxScroll >= 75) score += 10
  if (signals.lawyerViewed) score += 10
  if (signals.processViewed) score += 10
  if (signals.contactViewed) score += 10
  if (signals.formStarted) score += 20
  if (signals.pageViews >= 2) score += 15
  return Math.min(100, score)
}
