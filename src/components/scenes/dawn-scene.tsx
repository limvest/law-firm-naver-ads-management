'use client'
import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'

/**
 * 「새벽」 — three.js 입자 필드. 느리게 상승하는 먼지가 포인터 광원 근처에서 금빛으로 물들고,
 * 스크롤이 진행될수록 전체가 밝아진다. WebGL 불가·reduced-motion이면 초기화하지 않는다
 * (배경 여명 그라데이션은 DawnLanding의 CSS 레이어가 담당).
 */
export function DawnScene() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || prefersReducedMotion()) return
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return

    let disposed = false
    let cleanup: (() => void) | undefined

    void import('three').then((THREE) => {
      if (disposed) return
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false })
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
      camera.position.z = 10

      const small = typeof window !== 'undefined' && window.innerWidth < 768
      const COUNT = small ? 240 : 900
      const pos = new Float32Array(COUNT * 3)
      const seed = new Float32Array(COUNT)
      for (let i = 0; i < COUNT; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 24
        pos[i * 3 + 1] = (Math.random() - 0.5) * 14
        pos[i * 3 + 2] = (Math.random() - 0.5) * 8
        seed[i] = Math.random() * 6.28
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))

      const paleBlue = new THREE.Color('#9db8d9')
      const gold = new THREE.Color('#d9a441')
      const mat = new THREE.PointsMaterial({
        color: paleBlue, size: 0.055, transparent: true, opacity: 0.55,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
      const points = new THREE.Points(geo, mat)
      scene.add(points)

      // 금빛 광점 무리 — 포인터를 따라가는 별도 소집단
      const G = small ? 40 : 140
      const gpos = new Float32Array(G * 3)
      for (let i = 0; i < G; i++) {
        gpos[i * 3] = (Math.random() - 0.5) * 6
        gpos[i * 3 + 1] = (Math.random() - 0.5) * 4
        gpos[i * 3 + 2] = (Math.random() - 0.5) * 3
      }
      const ggeo = new THREE.BufferGeometry()
      ggeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3))
      const gmat = new THREE.PointsMaterial({
        color: gold, size: 0.07, transparent: true, opacity: 0.8,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
      const goldCloud = new THREE.Points(ggeo, gmat)
      scene.add(goldCloud)

      const target = { x: 2.4, y: 1.2 }
      const onMove = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect()
        target.x = ((e.clientX - r.left) / r.width - 0.5) * 12
        target.y = -((e.clientY - r.top) / r.height - 0.5) * 7
      }
      canvas.parentElement?.addEventListener('pointermove', onMove)

      function resize() {
        const r = canvas!.getBoundingClientRect()
        renderer.setSize(r.width, r.height, false)
        camera.aspect = r.width / Math.max(1, r.height)
        camera.updateProjectionMatrix()
      }
      resize()
      window.addEventListener('resize', resize)

      let raf = 0
      const t0 = performance.now()
      function frame(now: number) {
        const t = (now - t0) / 1000
        const p = geo.attributes.position as InstanceType<typeof THREE.BufferAttribute>
        for (let i = 0; i < COUNT; i++) {
          let y = p.getY(i) + 0.0035 + Math.sin(t * 0.6 + seed[i]) * 0.0009
          if (y > 7.2) y = -7.2
          p.setY(i, y)
        }
        p.needsUpdate = true
        goldCloud.position.x += (target.x - goldCloud.position.x) * 0.03
        goldCloud.position.y += (target.y - goldCloud.position.y) * 0.03
        goldCloud.rotation.y = t * 0.05
        points.rotation.y = t * 0.012
        // 스크롤 진행 → 입자 밝아짐 (여명)
        const doc = document.documentElement
        const prog = Math.min(1, window.scrollY / Math.max(1, doc.scrollHeight - window.innerHeight))
        mat.opacity = 0.45 + prog * 0.4
        renderer.render(scene, camera)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)

      cleanup = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('resize', resize)
        canvas.parentElement?.removeEventListener('pointermove', onMove)
        geo.dispose(); ggeo.dispose(); mat.dispose(); gmat.dispose(); renderer.dispose()
      }
    })

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />
}
