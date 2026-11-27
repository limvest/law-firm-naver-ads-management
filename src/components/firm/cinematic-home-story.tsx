'use client'

import { useEffect, useRef } from 'react'

const scenes = [
  {
    key: 's1', frames: 150,
    no: '01', label: 'EVIDENCE', title: ['기록이 사라지기 전에,', '먼저 지킵니다.'],
    body: '대화·이체·앱·사이트 화면을 사건의 시간순서에 맞춰 보전합니다.',
    note: '삭제되기 쉬운 기록부터 · 증거 보전',
  },
  {
    key: 's2', frames: 120,
    no: '02', label: 'FREEZE', title: ['움직이는 자금의', '길목을 확인합니다.'],
    body: '지급정지와 보전 조치가 가능한지, 적용 조건과 현재 단계를 신속히 검토합니다.',
    note: '가능성과 한계를 함께 · 차단 검토',
  },
  {
    key: 'br3', frames: 60,
    no: '03', label: 'INVESTIGATION', title: ['흩어진 기록을,', '수사의 언어로.'],
    body: '피해 경위와 증거 목록을 구조화해 고소와 조사 대응의 출발점을 만듭니다.',
    note: '사실관계 재구성 · 고소·수사 대응',
  },
  {
    key: 's4', frames: 150,
    no: '04', label: 'RECOVERY', title: ['회수와 처벌을,', '처음부터 함께 봅니다.'],
    body: '형사 절차와 별도로 가능한 민사상 보전과 회수 절차를 함께 설계합니다.',
    note: '사건별 적용 절차 검토 · 회수',
  },
] as const

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.clearRect(0, 0, width, height)
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}

export function CinematicHomeStory() {
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const canvases = [...root.querySelectorAll<HTMLCanvasElement>('canvas[data-sequence]')]
    const cache = new Map<string, HTMLImageElement>()
    let scheduled = false
    let lastScene = -1
    let lastFrame = -1

    const frameUrl = (key: string, frame: number) => {
      const mode = window.innerWidth <= 768 ? 'm' : 'd'
      return `/assets/seq/${key}/${mode}/f_${String(frame).padStart(3, '0')}.webp`
    }

    const paint = (canvas: HTMLCanvasElement, key: string, frame: number) => {
      const url = frameUrl(key, frame)
      const render = (image: HTMLImageElement) => {
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
        const width = Math.round(canvas.clientWidth * ratio)
        const height = Math.round(canvas.clientHeight * ratio)
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const context = canvas.getContext('2d')
        if (context && image.complete && image.naturalWidth) {
          drawCover(context, image, width, height)
          canvas.dataset.frame = String(frame)
        }
      }
      const cached = cache.get(url)
      if (cached) return render(cached)
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => render(image)
      image.src = url
      cache.set(url, image)
      if (cache.size > 96) cache.delete(cache.keys().next().value as string)
    }

    const update = () => {
      scheduled = false
      const rect = root.getBoundingClientRect()
      const span = Math.max(1, rect.height - window.innerHeight)
      const progress = Math.max(0, Math.min(1, -rect.top / span))
      const sceneIndex = Math.min(scenes.length - 1, Math.floor(progress * scenes.length))
      const scene = scenes[sceneIndex]
      const local = Math.max(0, Math.min(1, progress * scenes.length - sceneIndex))
      const frame = scene.frames ? Math.max(1, Math.min(scene.frames, Math.round(local * (scene.frames - 1)) + 1)) : 0

      root.dataset.scene = String(sceneIndex)
      root.style.setProperty('--story-progress', `${progress * 100}%`)
      if (sceneIndex !== lastScene || frame !== lastFrame) {
        lastScene = sceneIndex
        lastFrame = frame
        if (scene.frames) {
          const canvas = canvases.find((item) => item.dataset.sequence === scene.key)
          if (canvas) {
            paint(canvas, scene.key, frame)
            for (let ahead = 1; ahead <= 3; ahead += 1) {
              const next = Math.min(scene.frames, frame + ahead)
              const preload = new Image()
              preload.src = frameUrl(scene.key, next)
            }
          }
        }
      }
    }

    const requestUpdate = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(update)
    }
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) window.addEventListener('scroll', requestUpdate, { passive: true })
    window.addEventListener('resize', requestUpdate, { passive: true })
    update()
    return () => {
      window.removeEventListener('scroll', requestUpdate)
      window.removeEventListener('resize', requestUpdate)
    }
  }, [])

  return (
    <section className="cinematic-story" ref={rootRef} data-scene="0" id="response">
      <div className="cinematic-story-stage">
        <div className="cinematic-story-layer" data-layer="0"><canvas data-sequence="s1" /></div>
        <div className="cinematic-story-layer" data-layer="1"><canvas data-sequence="s2" /></div>
        <div className="cinematic-story-layer cinematic-story-static" data-layer="2"><canvas data-sequence="br3" /></div>
        <div className="cinematic-story-layer" data-layer="3"><canvas data-sequence="s4" /></div>
        <div className="cinematic-story-shade" aria-hidden="true" />

        <div className="cinematic-story-copies">
          {scenes.map((scene, index) => <article key={scene.key} data-copy={index}>
            <p><b>{scene.no}</b> — {scene.label}</p>
            <h2>{scene.title.map((line) => <span key={line}>{line}</span>)}</h2>
            <div>{scene.body}</div>
            <small>{scene.note}</small>
          </article>)}
        </div>

        <div className="cinematic-story-progress" aria-hidden="true"><i /></div>
        <div className="cinematic-story-index" aria-hidden="true">
          {scenes.map((scene, index) => <span key={scene.key} data-index={index}>{scene.no}</span>)}
        </div>
        <div className="cinematic-story-cue">스크롤하여 대응 과정을 확인하세요<i /></div>
      </div>
    </section>
  )
}
