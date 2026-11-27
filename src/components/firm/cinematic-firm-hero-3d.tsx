'use client'

import { useEffect, useRef } from 'react'

type RoundedPath = {
  moveTo: (x: number, y: number) => void
  lineTo: (x: number, y: number) => void
  quadraticCurveTo: (a: number, b: number, c: number, d: number) => void
}

function roundedRectPath(target: RoundedPath, width: number, height: number, radius: number) {
  const x = -width / 2
  const y = -height / 2
  target.moveTo(x + radius, y)
  target.lineTo(x + width - radius, y)
  target.quadraticCurveTo(x + width, y, x + width, y + radius)
  target.lineTo(x + width, y + height - radius)
  target.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  target.lineTo(x + radius, y + height)
  target.quadraticCurveTo(x, y + height, x, y + height - radius)
  target.lineTo(x, y + radius)
  target.quadraticCurveTo(x, y, x + radius, y)
}

export function CinematicFirmHero3D() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas || typeof WebGLRenderingContext === 'undefined') return

    let disposed = false
    let frameId = 0
    let cleanup = () => {}

    void import('three').then((THREE) => {
      if (disposed) return

      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.08
      renderer.shadowMap.enabled = window.innerWidth > 768
      renderer.shadowMap.type = THREE.PCFSoftShadowMap

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
      camera.position.set(0, 0.1, 10)

      const sculpture = new THREE.Group()
      scene.add(sculpture)

      const metal = new THREE.MeshPhysicalMaterial({ color: 0x22282b, metalness: 0.9, roughness: 0.24, clearcoat: 0.65, clearcoatRoughness: 0.2 })
      const bronze = new THREE.MeshPhysicalMaterial({ color: 0x9e7434, metalness: 0.92, roughness: 0.2, clearcoat: 0.72, clearcoatRoughness: 0.16 })
      const glass = new THREE.MeshPhysicalMaterial({ color: 0xd6c59c, metalness: 0.05, roughness: 0.12, transmission: 0.72, thickness: 0.6, transparent: true, opacity: 0.5 })

      const shape = new THREE.Shape()
      roundedRectPath(shape, 3.25, 4.15, 0.68)
      const hole = new THREE.Path()
      roundedRectPath(hole, 2.55, 3.45, 0.5)
      shape.holes.push(hole)
      const frameGeometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.18,
        bevelEnabled: true,
        bevelSegments: 5,
        bevelSize: 0.055,
        bevelThickness: 0.055,
        curveSegments: 12,
      })
      frameGeometry.center()

      const frameTransforms = [
        { p: [-0.42, 0.26, 0.2], r: [0.12, 0.46, -0.17], s: 1 },
        { p: [0.56, 0.06, -0.35], r: [-0.22, -0.52, 0.31], s: 0.9 },
        { p: [0.05, -0.35, -0.9], r: [0.55, 0.12, 0.78], s: 0.78 },
        { p: [0.3, 0.5, -1.34], r: [-0.58, 0.72, -0.62], s: 0.66 },
      ] as const

      frameTransforms.forEach((transform, index) => {
        const mesh = new THREE.Mesh(frameGeometry, index === 2 ? bronze : metal)
        mesh.position.set(transform.p[0], transform.p[1], transform.p[2])
        mesh.rotation.set(transform.r[0], transform.r[1], transform.r[2])
        mesh.scale.setScalar(transform.s)
        mesh.castShadow = true
        mesh.receiveShadow = true
        sculpture.add(mesh)
      })

      const shieldGeometry = new THREE.SphereGeometry(1.12, 64, 64)
      const shield = new THREE.Mesh(shieldGeometry, glass)
      shield.scale.set(1, 1.08, 0.55)
      shield.position.set(0.12, 0.04, 0.05)
      sculpture.add(shield)

      const coreMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xffd88b,
        emissive: 0xb87522,
        emissiveIntensity: 2.1,
        metalness: 0.08,
        roughness: 0.16,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      })
      const coreGeometry = new THREE.SphereGeometry(0.43, 48, 48)
      const core = new THREE.Mesh(coreGeometry, coreMaterial)
      core.position.set(0.12, 0.04, 0.48)
      core.castShadow = true
      sculpture.add(core)

      const particlePositions = new Float32Array(54 * 3)
      for (let index = 0; index < 54; index += 1) {
        const radius = 2.6 + (index % 9) * 0.16
        const angle = index * 2.399
        particlePositions[index * 3] = Math.cos(angle) * radius
        particlePositions[index * 3 + 1] = Math.sin(angle * 1.17) * 2.25
        particlePositions[index * 3 + 2] = -1.8 + (index % 7) * 0.28
      }
      const particleGeometry = new THREE.BufferGeometry()
      particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
      const particleMaterial = new THREE.PointsMaterial({ color: 0xb9904c, size: 0.035, transparent: true, opacity: 0.58 })
      const particles = new THREE.Points(particleGeometry, particleMaterial)
      sculpture.add(particles)

      scene.add(new THREE.HemisphereLight(0xf2eee5, 0x3a4144, 2.7))
      const key = new THREE.DirectionalLight(0xfff4d6, 4.2)
      key.position.set(-3.5, 5.5, 7)
      key.castShadow = true
      key.shadow.mapSize.set(1024, 1024)
      scene.add(key)
      const rim = new THREE.PointLight(0xc49642, 18, 10, 1.8)
      rim.position.set(0.2, 0.1, 2.2)
      scene.add(rim)
      const cool = new THREE.PointLight(0x9bc3c5, 8, 12, 2)
      cool.position.set(4, -2.5, 1)
      scene.add(cool)

      let pointerX = 0
      let pointerY = 0
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const onPointerMove = (event: PointerEvent) => {
        pointerX = (event.clientX / window.innerWidth - 0.5) * 2
        pointerY = (event.clientY / window.innerHeight - 0.5) * 2
      }
      const resize = () => {
        const { width, height } = root.getBoundingClientRect()
        renderer.setSize(width, height, false)
        camera.aspect = width / Math.max(1, height)
        camera.updateProjectionMatrix()
        const mobile = width <= 700
        sculpture.position.set(mobile ? 0 : 1.75, mobile ? 0.85 : 0.05, 0)
        sculpture.scale.setScalar(mobile ? 0.73 : 0.96)
      }

      const clock = new THREE.Clock()
      const render = () => {
        const time = clock.getElapsedTime()
        const targetX = pointerY * 0.09
        const targetY = pointerX * 0.15
        sculpture.rotation.x += (targetX - sculpture.rotation.x) * 0.035
        sculpture.rotation.y += (targetY + Math.sin(time * 0.18) * 0.08 - sculpture.rotation.y) * 0.035
        sculpture.rotation.z = Math.sin(time * 0.27) * 0.018
        const baseY = window.innerWidth <= 700 ? 0.85 : 0.05
        sculpture.position.y += (baseY + Math.sin(time * 0.45) * 0.055 - sculpture.position.y) * 0.04
        core.scale.setScalar(1 + Math.sin(time * 1.45) * 0.035)
        particles.rotation.z = time * 0.025
        renderer.render(scene, camera)
        if (!reduced) frameId = requestAnimationFrame(render)
      }

      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('resize', resize, { passive: true })
      resize()
      root.dataset.ready = 'true'
      render()

      cleanup = () => {
        cancelAnimationFrame(frameId)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('resize', resize)
        frameGeometry.dispose()
        shieldGeometry.dispose()
        coreGeometry.dispose()
        particleGeometry.dispose()
        ;[metal, bronze, glass, coreMaterial, particleMaterial].forEach((material) => material.dispose())
        renderer.dispose()
      }
    }).catch(() => {
      root.dataset.ready = 'fallback'
    })

    return () => {
      disposed = true
      cleanup()
    }
  }, [])

  return (
    <div className="cinematic-firm-hero-3d" ref={rootRef} aria-hidden="true">
      <div className="cinematic-firm-hero-fallback"><i /><i /><i /><i /><b /></div>
      <canvas ref={canvasRef} />
    </div>
  )
}
