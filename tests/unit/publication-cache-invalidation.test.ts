import { describe, expect, it } from 'vitest'
import {
  buildPublicationCacheInvalidation,
  createPublicationCacheInvalidator,
  publicPublicationPaths,
  shouldInvalidatePublicationCache,
} from '@/domains/publishing'

describe('publication cache invalidation boundary', () => {
  it('derives deterministic target and legacy public paths', () => {
    expect(publicPublicationPaths({ assetType: 'seo_page', caseSlug: 'alpha case' })).toEqual([
      '/case/alpha%20case',
      '/f/alpha%20case',
    ])
    expect(publicPublicationPaths({ assetType: 'ad_landing', caseSlug: 'alpha case' })).toEqual([
      '/response/alpha%20case',
      '/f/alpha%20case',
    ])
  })

  it('invalidates only public exposure/version changes', () => {
    expect(shouldInvalidatePublicationCache({
      previousStatus: 'pending', status: 'pending',
      previousDeployedVersion: '1', deployedVersion: '1',
    })).toBe(false)
    expect(shouldInvalidatePublicationCache({
      previousStatus: 'pending', status: 'live',
      previousDeployedVersion: '1', deployedVersion: '1',
    })).toBe(true)
    expect(shouldInvalidatePublicationCache({
      previousStatus: 'pending', status: 'pending',
      previousDeployedVersion: '1', deployedVersion: '2',
    })).toBe(true)
  })

  it('adapts one event to path/tag framework hooks without importing Next', async () => {
    const paths: string[] = []
    const tags: string[] = []
    const invalidate = createPublicationCacheInvalidator({
      revalidatePath: (path) => paths.push(path),
      revalidateTag: (tag) => tags.push(tag),
    })
    const event = buildPublicationCacheInvalidation({
      publicationId: 'publication-1',
      firmId: 51,
      caseEntityId: 'case-1',
      contentAssetId: 'asset-1',
      caseSlug: 'alpha',
      assetType: 'seo_page',
      previousStatus: 'pending',
      status: 'live',
      previousDeployedVersion: '1',
      deployedVersion: '1',
    })

    await invalidate(event)

    expect(event).toMatchObject({
      reason: 'became-live',
      paths: ['/case/alpha', '/f/alpha'],
      tags: [
        'publication:publication-1',
        'firm:51',
        'case:case-1',
        'content-asset:asset-1',
      ],
    })
    expect(paths).toEqual(['/case/alpha', '/f/alpha'])
    expect(tags).toEqual([
      'publication:publication-1',
      'firm:51',
      'case:case-1',
      'content-asset:asset-1',
    ])
  })
})
