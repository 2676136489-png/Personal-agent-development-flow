import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * 首屏：玻璃立方体折射背景标题。
 *
 * 三个关键决定（都是为了让「折射」这件事成立，而不只是做个玻璃质感）：
 *
 * 1. 标题不是 HTML 文字，而是画在离屏 2D canvas 上的纹理。
 *    只有先有一张「可采样的图」，才能让立方体按法线偏移去采它的像素；
 *    HTML 文字是合成层，着色器碰不到。可访问性由视觉隐藏的 h1 兜底。
 *
 * 2. 玻璃用两遍渲染：先把「背景 + 背面」渲进 rtFront，再拿它给正面当折射源；
 *    背面采样的是纯背景 rtBack。这样能看见立方体后壁的圆弧内缘，
 *    以及透过玻璃被放大、镜像、拆成蓝黄边的文字。
 *
 * 3. 六个波段（R/Y/G/C/B/P）各自的 IOR 略有差异，逐帧 16 次折射采样后
 *    重建 RGB。色散不是叠一层渐变，而是真的按不同折射率偏移采样位置。
 */

// 模型已下载到 public/models/glass.glb，由同源提供，不再从第三方站点实时拉取。
// 原地址：https://motionsites.org/assets/prompt-media/fa96096e78c8153a70d2.glb
// SHA-256：047A996E8EF10A97C23FEFEFD66FB36D9FE235659075DC4DD7891B22AD3CAEE6
// 注意：这是第三方设计资源，商用或再分发前请确认原始授权。
const MODEL_URL = '/models/glass.glb'

const BG_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const BG_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uTex, vUv);
    #include <colorspace_fragment>
  }
`

const GLASS_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vEye;
  void main() {
    vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPos;
    vNormal = normalize(normalMatrix * normal);
    vEye = normalize(mvPos.xyz);
  }
`

const GLASS_FRAG = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform float uIorR;
  uniform float uIorY;
  uniform float uIorG;
  uniform float uIorC;
  uniform float uIorB;
  uniform float uIorP;
  uniform float uRefractPower;
  uniform float uChromatic;
  uniform float uSaturation;
  uniform float uShininess;
  uniform float uDiffuseness;
  uniform float uFresnelPower;
  uniform float uBackside;
  uniform vec3 uLight;

  varying vec3 vNormal;
  varying vec3 vEye;

  // Blinn-Phong：高光 + 一点漫反射，用来让倒角在纯黑底上有一圈白边
  float specular(vec3 light, float shininess, float diffuseness) {
    vec3 n = normalize(vNormal);
    if (uBackside > 0.5) n = -n;
    vec3 lightVector = normalize(-light);
    vec3 halfVector = normalize(vEye + lightVector);
    float dotNormalHalf = max(dot(n, halfVector), 0.0);
    float spec = pow(dotNormalHalf, shininess);
    float diff = max(dot(n, lightVector), 0.0);
    return spec + diff * diffuseness;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;

    vec3 n = normalize(vNormal);
    // three.js 对 BackSide 会翻转绕序，这里不能用 gl_FrontFacing，否则背面法线取反两次
    if (uBackside > 0.5) n = -n;

    vec3 eye = normalize(vEye);

    vec3 color = vec3(0.0);
    const int LOOP = 16;

    for (int i = 0; i < LOOP; i++) {
      float slide = float(i) / float(LOOP) * 0.045;

      vec3 refrR = refract(eye, n, 1.0 / uIorR);
      vec3 refrY = refract(eye, n, 1.0 / uIorY);
      vec3 refrG = refract(eye, n, 1.0 / uIorG);
      vec3 refrC = refract(eye, n, 1.0 / uIorC);
      vec3 refrB = refract(eye, n, 1.0 / uIorB);
      vec3 refrP = refract(eye, n, 1.0 / uIorP);

      vec3 tR = texture2D(uTexture, uv + refrR.xy * (uRefractPower + slide * 1.0) * uChromatic).rgb;
      vec3 tY = texture2D(uTexture, uv + refrY.xy * (uRefractPower + slide * 1.0) * uChromatic).rgb;
      vec3 tG = texture2D(uTexture, uv + refrG.xy * (uRefractPower + slide * 2.0) * uChromatic).rgb;
      vec3 tC = texture2D(uTexture, uv + refrC.xy * (uRefractPower + slide * 2.5) * uChromatic).rgb;
      vec3 tB = texture2D(uTexture, uv + refrB.xy * (uRefractPower + slide * 3.0) * uChromatic).rgb;
      vec3 tP = texture2D(uTexture, uv + refrP.xy * (uRefractPower + slide * 1.0) * uChromatic).rgb;

      float r = tR.x * 0.5;
      float y = (tY.x * 2.0 + tY.y * 2.0 - tY.z) / 6.0;
      float g = tG.y * 0.5;
      float c = (tC.y * 2.0 + tC.z * 2.0 - tC.x) / 6.0;
      float b = tB.z * 0.5;
      float p = (tP.z * 2.0 + tP.x * 2.0 - tP.y) / 6.0;

      float R = r + (2.0 * p + 2.0 * y - c) / 3.0;
      float G = g + (2.0 * y + 2.0 * c - p) / 3.0;
      float B = b + (2.0 * c + 2.0 * p - y) / 3.0;

      color += vec3(R, G, B);
    }

    color /= float(LOOP);

    // 饱和度：0 变灰、1 保持、>1 更艳。玻璃边缘的色边靠它压住，不让整块发糊
    float luma = dot(color, vec3(0.2125, 0.7154, 0.0721));
    color = mix(vec3(luma), color, uSaturation);

    float spec = specular(uLight, uShininess, uDiffuseness)
      + 0.6 * specular(vec3(1.0, 1.0, -1.0), uShininess * 0.6, uDiffuseness * 0.5);
    color += spec * (uBackside > 0.5 ? 0.35 : 1.0);

    // 菲涅尔：视线越掠射越接近纯白，倒角就靠这一圈亮起来
    float f = pow(1.0 + dot(eye, n), uFresnelPower);
    color = mix(color, vec3(1.0), f * (uBackside > 0.5 ? 0.25 : 0.55));

    // 极低的环境光：只给玻璃一点体积感。0.004~0.007 会在纯黑底上把整块玻璃
    // 抬成中灰（两遍渲染还会叠加一次），看起来像不透明的深色亚克力。
    // 背面再压到 30%：背面只是给正面提供一次折射源，它自己不该有实体感。
    color += vec3(0.0018, 0.0022, 0.003) * (uBackside > 0.5 ? 0.3 : 1.0);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`

interface GlassApi {
  rotateBy: (dx: number, dy: number) => void
  spin: (direction: 1 | -1) => void
}

export function GlassHero({ onExplore }: { onExplore?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const loaderRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<GlassApi | null>(null)
  const [dot, setDot] = useState(1)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    renderer.setClearColor(0x000000, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
    camera.position.set(0, 0, 10)

    const scene = new THREE.Scene()
    const pivot = new THREE.Object3D()
    const spinner = new THREE.Object3D()
    pivot.add(spinner)
    scene.add(pivot)

    // ---- 背景标题：离屏 2D canvas → CanvasTexture ----
    const textCanvas = document.createElement('canvas')
    const ctx = textCanvas.getContext('2d')
    const texture = new THREE.CanvasTexture(textCanvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false

    const bgScene = new THREE.Scene()
    const bgMaterial = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: texture } },
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
    })
    const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial)
    bgQuad.frustumCulled = false
    bgScene.add(bgQuad)

    // ---- 玻璃：六个波段的 IOR 都略高于 1，正/背面各一套 ----
    const makeGlass = (backside: number, refractPower: number) =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTexture: { value: null },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uIorR: { value: 1.15 },
          uIorY: { value: 1.16 },
          uIorG: { value: 1.18 },
          uIorC: { value: 1.22 },
          uIorB: { value: 1.22 },
          uIorP: { value: 1.22 },
          uRefractPower: { value: refractPower },
          uChromatic: { value: 0.5 },
          uSaturation: { value: 1.08 },
          uShininess: { value: 90 },
          uDiffuseness: { value: 0.02 },
          uFresnelPower: { value: 5 },
          uBackside: { value: backside },
          uLight: { value: new THREE.Vector3(-1, 1, 1) },
        },
        vertexShader: GLASS_VERT,
        fragmentShader: GLASS_FRAG,
        transparent: true,
        side: backside > 0.5 ? THREE.BackSide : THREE.FrontSide,
      })

    const backMat = makeGlass(1, 0.22)
    const frontMat = makeGlass(0, 0.3)

    // 显式标成 Mesh：加载完成后会把兜底几何换成合并后的 GLB 几何
    const mesh: THREE.Mesh = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 8, 0.12), frontMat)
    spinner.add(mesh)
    spinner.quaternion.copy(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, 0.62, 0.18)))

    // ---- 两套渲染目标：背景一份，背景 + 背面一份 ----
    const createTarget = () =>
      new THREE.WebGLRenderTarget(2, 2, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
      })
    const rtBack = createTarget()
    const rtFront = createTarget()
    backMat.uniforms.uTexture.value = rtBack.texture
    frontMat.uniforms.uTexture.value = rtFront.texture

    // ---- 尺寸与布局 ----
    let width = 1
    let height = 1
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let mobile = false

    const drawHeadline = () => {
      if (!ctx) return
      const cw = Math.max(1, Math.round(width * dpr))
      const ch = Math.max(1, Math.round(height * dpr))
      textCanvas.width = cw
      textCanvas.height = ch
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)

      let fs = Math.min(height * 0.21, width * (mobile ? 0.21 : 0.118))
      ctx.font = `800 ${fs}px Poppins`
      const widest = Math.max(
        ctx.measureText('Explore').width,
        ctx.measureText('New').width,
        ctx.measureText('Ideas').width,
      )
      const limit = width * (mobile ? 0.9 : 0.5)
      if (widest > limit) {
        fs *= limit / widest
        ctx.font = `800 ${fs}px Poppins`
      }

      ctx.fillStyle = '#e9e9e9'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'

      const cx = width * (mobile ? 0.5 : 0.505)
      const cy = height * (mobile ? 0.45 : 0.468)
      const gap = fs * 1.07
      const cap = fs * 0.7
      const lines = ['Explore', 'New', 'Ideas']
      lines.forEach((line, i) => {
        ctx.fillText(line, cx, cy + cap / 2 + (i - 1) * gap)
      })

      texture.needsUpdate = true
    }

    const layout = () => {
      width = Math.max(1, window.innerWidth)
      height = Math.max(1, Math.max(canvas.clientHeight, 1))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      mobile = width < 768 || width / height < 1

      renderer.setPixelRatio(dpr)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()

      const buffer = renderer.getDrawingBufferSize(new THREE.Vector2())
      rtBack.setSize(buffer.x, buffer.y)
      rtFront.setSize(buffer.x, buffer.y)
      ;(backMat.uniforms.uResolution.value as THREE.Vector2).copy(buffer)
      ;(frontMat.uniforms.uResolution.value as THREE.Vector2).copy(buffer)

      const visH = 2 * Math.tan(((camera.fov / 2) * Math.PI) / 180) * 10
      const visW = visH * camera.aspect

      const sx = mobile ? 0.5 : 0.517
      const sy = mobile ? 0.45 : 0.488
      pivot.position.set((sx - 0.5) * visW, (0.5 - sy) * visH, 0)

      const px = Math.min(height * 0.44, width * (mobile ? 0.45 : 0.29))
      pivot.scale.setScalar((px / height) * visH)

      drawHeadline()
    }

    layout()

    // ---- 模型：合并成单一几何体，中心化并按最长边归一 ----
    let disposed = false
    const loaderEl = loaderRef.current
    const heroEl = canvas.parentElement
    let safetyTimer = 0
    const finishLoading = (source: string) => {
      // StrictMode 下 effect 会跑两遍：被清理掉的那一轮的兜底计时器不能再改 DOM，
      // 否则它会在模型早已加载完成后把状态覆盖回 fallback。
      if (disposed) return
      if (heroEl) heroEl.dataset.model = source
      loaderEl?.classList.add('done')
    }
    if (heroEl) heroEl.dataset.model = 'loading'

    const installGeometry = (geometry: THREE.BufferGeometry) => {
      if (disposed) {
        geometry.dispose()
        return
      }
      geometry.computeBoundingBox()
      const box = geometry.boundingBox
      if (box) {
        const center = new THREE.Vector3()
        box.getCenter(center)
        geometry.translate(-center.x, -center.y, -center.z)
        const size = new THREE.Vector3()
        box.getSize(size)
        const max = Math.max(size.x, size.y, size.z) || 1
        geometry.scale(1 / max, 1 / max, 1 / max)
        geometry.computeBoundingSphere()
      }
      const previous = mesh.geometry
      mesh.geometry = geometry
      previous.dispose()
      finishLoading('glb')
      window.clearTimeout(safetyTimer)
    }

    const gltfLoader = new GLTFLoader()
    gltfLoader.load(
      MODEL_URL,
      (gltf) => {
        if (disposed) return
        try {
          gltf.scene.updateMatrixWorld(true)
          const parts: THREE.BufferGeometry[] = []
          gltf.scene.traverse((child) => {
            if (!(child as THREE.Mesh).isMesh) return
            const source = (child as THREE.Mesh).geometry as THREE.BufferGeometry
            const geometry = source.clone()
            geometry.deleteAttribute('uv')
            geometry.deleteAttribute('color')
            geometry.deleteAttribute('tangent')
            const merged = mergeVertices(geometry, 1e-4)
            merged.computeVertexNormals()
            merged.applyMatrix4(child.matrixWorld)
            parts.push(merged)
          })
          const combined = parts.length > 0 ? mergeGeometries(parts, false) : null
          parts.forEach((part) => part.dispose())
          if (combined) installGeometry(combined)
          else finishLoading('merge-failed')
        } catch (error) {
          // 模型结构不符预期时不阻断首屏：保留兜底几何
          console.warn('[hero] merge failed', error)
          finishLoading('exception')
        }
      },
      undefined,
      (error) => {
        // 加载失败：由已经挂上的 RoundedBoxGeometry 兜底
        console.warn('[hero] glb load failed', error)
        finishLoading('error')
      },
    )

    // 网络挂住时不让 "Loading model" 永远停在屏幕正中；8s 后按兜底几何收尾
    safetyTimer = window.setTimeout(() => finishLoading('fallback'), 8000)

    // ---- 交互 ----
    let dragging = false
    let pointerId = -1
    let lastX = 0
    let lastY = 0
    let lastT = 0
    let velX = 0
    let velY = 0
    let idleDelay = 0
    let idleBlend = 0
    let spinning = false
    let spinCurrent = 0
    let spinTarget = 0

    const rotate = (dx: number, dy: number) => {
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx)
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy)
      spinner.quaternion.premultiply(qy).premultiply(qx)
    }

    apiRef.current = {
      rotateBy: rotate,
      spin: (direction) => {
        velX = 0
        velY = 0
        spinning = true
        spinCurrent = 0
        spinTarget += (direction * Math.PI) / 2
      },
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      dragging = true
      pointerId = event.pointerId
      lastX = event.clientX
      lastY = event.clientY
      lastT = performance.now()
      velX = 0
      velY = 0
      idleDelay = 0
      idleBlend = 0
      spinning = false
      canvas.setPointerCapture(event.pointerId)
      canvas.classList.add('dragging')
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return
      const now = performance.now()
      const dt = Math.max(1, now - lastT)
      const dx = (event.clientX - lastX) * 0.008
      const dy = (event.clientY - lastY) * 0.008
      const frames = Math.max(1, dt / 16.67)
      rotate(dx, dy)
      velX = dx / frames
      velY = dy / frames
      lastX = event.clientX
      lastY = event.clientY
      lastT = now
    }

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      dragging = false
      pointerId = -1
      idleDelay = 0.6
      canvas.classList.remove('dragging')
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    // ---- 循环 ----
    let raf = 0
    let previous = performance.now()
    const clock = { value: 0 }

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - previous) / 1000)
      previous = now
      clock.value += dt
      const stepFrames = dt * 60

      if (!dragging) {
        if (Math.abs(velX) > 0.00002 || Math.abs(velY) > 0.00002) {
          rotate(velX * stepFrames, velY * stepFrames)
          const damp = Math.pow(0.94, stepFrames)
          velX *= damp
          velY *= damp
        } else {
          velX = 0
          velY = 0
          if (idleDelay > 0) {
            idleDelay -= dt
          } else {
            idleBlend = Math.min(1, idleBlend + dt)
          }
        }
      }

      // 待机自转：从加载起就在跑，拖拽时暂停，松手 0.6s 后 1s 内渐入
      if (!dragging && idleBlend > 0) {
        rotate(0.0035 * stepFrames * idleBlend, 0.0012 * stepFrames * idleBlend)
      }

      // 箭头：-90° / +90°，指数缓动到目标角度；拖拽会打断
      if (spinning) {
        const remaining = spinTarget - spinCurrent
        if (Math.abs(remaining) < 0.0005) {
          spinning = false
          spinCurrent = spinTarget
        } else {
          const step = remaining * Math.min(1, 0.09 * stepFrames)
          rotate(step, 0)
          spinCurrent += step
        }
      }
      if (dragging) {
        spinTarget = spinCurrent
        spinning = false
      }

      // 1) 背景 → rtBack
      renderer.autoClear = true
      renderer.setRenderTarget(rtBack)
      renderer.render(bgScene, camera)

      // 2) 背景 + 背面 → rtFront
      renderer.setRenderTarget(rtFront)
      renderer.render(bgScene, camera)
      renderer.autoClear = false
      renderer.clearDepth()
      mesh.material = backMat
      renderer.render(scene, camera)

      // 3) 背景 + 正面 → 屏幕
      // ⚠️ 这里必须先关掉 autoClear 再画立方体：否则第二遍 render 会把刚画好的
      // 背景连颜色一起清掉，屏幕上只剩玻璃自身 —— 表现为「标题消失、玻璃发灰」。
      renderer.setRenderTarget(null)
      renderer.autoClear = true
      renderer.render(bgScene, camera)
      renderer.autoClear = false
      renderer.clearDepth()
      mesh.material = frontMat
      renderer.render(scene, camera)
      renderer.autoClear = true

      raf = requestAnimationFrame(frame)
    }

    const onResize = () => layout()
    window.addEventListener('resize', onResize)

    const fontTimer = window.setTimeout(() => drawHeadline(), 2600)
    const start = () => {
      window.clearTimeout(fontTimer)
      window.clearTimeout(safetyTimer)
      drawHeadline()
      previous = performance.now()
      raf = requestAnimationFrame(frame)
    }

    const fontPromise = Promise.all([
      document.fonts?.load('800 100px Poppins') ?? Promise.resolve(),
      document.fonts?.ready ?? Promise.resolve(),
    ])
    const timeout = new Promise((resolve) => window.setTimeout(resolve, 2500))
    let stopped = false
    void Promise.race([fontPromise, timeout]).then(() => {
      if (!stopped) start()
    })

    if (document.fonts) {
      document.fonts.addEventListener('loadingdone', drawHeadline)
    }

    return () => {
      stopped = true
      disposed = true
      cancelAnimationFrame(raf)
      window.clearTimeout(fontTimer)
      window.removeEventListener('resize', onResize)
      document.fonts?.removeEventListener('loadingdone', drawHeadline)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      apiRef.current = null
      rtBack.dispose()
      rtFront.dispose()
      texture.dispose()
      bgMaterial.dispose()
      backMat.dispose()
      frontMat.dispose()
      mesh.geometry.dispose()
      bgQuad.geometry.dispose()
      renderer.dispose()
    }
  }, [])

  return (
    <section className="hero" id="hero">
      <canvas id="scene" ref={canvasRef} aria-label="Rotatable glass cube. Drag to rotate." />

      <div className="ui">
        {/* 大标题画在 WebGL 里，这里只留一个可读的语义标题 */}
        <h1 className="sr-only">Explore New Ideas</h1>

        <div className="arrows">
          <button
            className="arrow"
            id="prev"
            type="button"
            aria-label="向左旋转 90 度"
            onClick={() => apiRef.current?.spin(-1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M11 6l-6 6 6 6" />
            </svg>
          </button>
          <button
            className="arrow"
            id="next"
            type="button"
            aria-label="向右旋转 90 度"
            onClick={() => apiRef.current?.spin(1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>

        <nav className="dots" aria-label="轮播位置">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              type="button"
              className={`dot${dot === index ? ' active' : ''}`}
              aria-label={`第 ${index + 1} 屏`}
              aria-current={dot === index}
              onClick={() => setDot(index)}
            />
          ))}
        </nav>

        <p className="tagline">
          Let&apos;s Build the
          <br />
          Future of <strong>Research.</strong>
        </p>

        <div className="cta-row">
          <a
            href="#"
            className="cta"
            onClick={(event) => {
              event.preventDefault()
              onExplore?.()
            }}
          >
            Explore Now
          </a>
          <span className="cta-line" />
          {/* 07 = 研究流水线的七个阶段，同时充当出血的版面重心 */}
          <span className="count" aria-hidden="true">
            07
          </span>
        </div>

        <div className="loader" id="loader" ref={loaderRef}>
          Loading model
        </div>
      </div>
    </section>
  )
}
