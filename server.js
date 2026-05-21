require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
// file:// 포함 모든 origin 허용 (CORS)
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ──────────────────────────────────────────
   1. PDP 크롤러
────────────────────────────────────────── */
async function crawlLGPDP(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ]
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    // Full HD 1920×1080 — PC 데스크톱 레이아웃 강제 (모바일 이미지 회피, 고해상도 srcset 선택)
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    // 1단계: domcontentloaded로 빠르게 로딩 (networkidle2 대신)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
      console.warn('Initial load warning (continuing):', e.message);
    }

    // 2단계: 쿠키 배너 닫기
    try {
      await page.waitForSelector(
        'button[id*="accept"], button[class*="accept"], #onetrust-accept-btn-handler, .cookie-accept',
        { timeout: 3000 }
      );
      await page.click('button[id*="accept"], button[class*="accept"], #onetrust-accept-btn-handler, .cookie-accept');
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) { /* 쿠키 배너 없으면 무시 */ }

    // 3단계: 주요 콘텐츠 로딩 대기 (최대 15초)
    try {
      await page.waitForSelector(
        '[class*="feature"], [class*="benefit"], [class*="highlight"], .section-inner, main img',
        { timeout: 15000 }
      );
    } catch (_) { /* 없으면 무시 */ }

    // 4단계: 스크롤하여 lazy-load 이미지 트리거
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let scrolled = 0;
        const step = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          scrolled += step;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 150);
        // 최대 8초 후 강제 종료
        setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
      });
    });

    // 5단계: 이미지 로딩 안정화 대기
    await new Promise(r => setTimeout(r, 2000));

    // Feature 섹션 + 전체 콘텐츠 구조 추출
    const data = await page.evaluate(() => {
      const result = {
        title: '',
        subtitle: '',
        modelName: '',
        features: [],
        specs: [],
        heroImages: []
      };

      // ── 상대 URL → 절대 URL ────────────────────────────────────────
      function absUrl(u) {
        if (!u) return '';
        u = u.trim();
        if (u.startsWith('data:') || u.startsWith('blob:')) return u;
        if (u.startsWith('//')) return location.protocol + u;
        if (u.startsWith('/')) return location.origin + u;
        if (!u.startsWith('http')) { try { return new URL(u, location.href).href; } catch (_) {} }
        return u;
      }

      // ── <picture> · lazy-load · srcset 을 모두 고려한 최적 src 추출 ──
      // naturalWidth > 100 조건을 제거하고, 미로드(0px) 이미지도 URL이 있으면 허용
      function resolveSrc(img) {
        // 1) <picture> 안의 <source> — 데스크톱(min-width≥600) 우선
        const picture = img.closest('picture');
        if (picture) {
          const sources = Array.from(picture.querySelectorAll('source'));
          const order = ['desktop', 'neutral', 'mobile'];
          const classified = {
            desktop: sources.filter(s => {
              const m = (s.getAttribute('media') || '').toLowerCase();
              return /min-width\s*:\s*(\d+)px/.test(m) && parseInt(m.match(/min-width\s*:\s*(\d+)px/)[1]) >= 600;
            }),
            neutral: sources.filter(s => !s.getAttribute('media')),
            mobile:  sources.filter(s => {
              const m = (s.getAttribute('media') || '').toLowerCase();
              return /max-width\s*:\s*(\d+)px/.test(m) && !(/min-width/.test(m));
            }),
          };
          for (const group of order) {
            for (const src of classified[group]) {
              const ss = src.srcset || src.getAttribute('srcset') || src.getAttribute('data-srcset') || '';
              if (ss) return absUrl(ss.split(',')[0].trim().split(/\s+/)[0]);
            }
          }
        }
        // 2) img srcset / data-srcset
        const ss = img.srcset || img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        if (ss) return absUrl(ss.split(',')[0].trim().split(/\s+/)[0]);
        // 3) lazy-load 속성 (data-src 계열)
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                        img.getAttribute('data-original') || img.getAttribute('data-lazy') || '';
        if (lazySrc) return absUrl(lazySrc);
        // 4) currentSrc (브라우저 선택 URL) 또는 src
        return absUrl(img.currentSrc || img.getAttribute('src') || '');
      }

      // ── 아이콘 · 로고 · placeholder · 소형 이미지 필터 ──────────────
      function isContentImage(img, src) {
        if (!src) return false;
        if (/icon|logo|svg|blank|placeholder|transparent|spacer|1x1|loading/i.test(src)) return false;
        // naturalWidth 이 확정된 경우에만 크기 필터 적용 (0 = 미로드 → 허용)
        if (img.naturalWidth > 0 && img.naturalWidth < 100) return false;
        return true;
      }

      // 제품명
      result.title =
        document.querySelector('h1.prod-title, h1.tit, .visual-area h1, h1')?.innerText?.trim() || '';
      result.subtitle =
        document.querySelector('.sub-tit, .visual-area .sub-title, h2')?.innerText?.trim() || '';
      result.modelName =
        document.querySelector('.model-name, .sku, [class*="model"]')?.innerText?.trim() || '';

      // Hero 이미지
      const heroImgs = document.querySelectorAll(
        '.visual-area img, .hero-area img, .kv-area img, [class*="hero"] img, [class*="visual"] img'
      );
      heroImgs.forEach(img => {
        const src = resolveSrc(img);
        if (isContentImage(img, src)) {
          result.heroImages.push({ src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight });
        }
      });

      // Feature 섹션 추출
      // LG.com feature 섹션은 보통 .feature-group, .product-feature, [class*="feature"] 등
      const featureSections = document.querySelectorAll(
        '[class*="feature"], [class*="benefit"], [class*="reason"], [class*="highlight"], .section-inner, .cont-inner'
      );

      featureSections.forEach(section => {
        // 섹션 내 이미지 — picture/lazy-load/srcset 모두 처리
        const imgs = section.querySelectorAll('img');
        const sectionImages = [];
        imgs.forEach(img => {
          const src = resolveSrc(img);
          if (!isContentImage(img, src)) return;
          sectionImages.push({
            src,
            alt: img.alt || '',
            width:  img.naturalWidth  || +img.getAttribute('width')  || 0,
            height: img.naturalHeight || +img.getAttribute('height') || 0,
            ratio:  img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : 1
          });
        });

        // 섹션 내 텍스트
        const headings = Array.from(section.querySelectorAll('h2, h3, h4, strong, .tit, .title, [class*="title"], [class*="tit"]'))
          .map(el => el.innerText?.trim()).filter(t => t && t.length > 2 && t.length < 200);

        const bodies = Array.from(section.querySelectorAll('p, .desc, .txt, [class*="desc"], [class*="body"]'))
          .map(el => el.innerText?.trim()).filter(t => t && t.length > 5 && t.length < 1000);

        const bullets = Array.from(section.querySelectorAll('li'))
          .map(el => el.innerText?.trim()).filter(t => t && t.length > 2 && t.length < 300);

        if (sectionImages.length > 0 || headings.length > 0) {
          result.features.push({
            images: sectionImages,
            headings: [...new Set(headings)].slice(0, 3),
            bodies: [...new Set(bodies)].slice(0, 3),
            bullets: [...new Set(bullets)].slice(0, 6)
          });
        }
      });

      // 중복 제거 및 의미있는 섹션만
      const seen = new Set();
      result.features = result.features.filter(f => {
        const key = (f.headings[0] || '') + (f.images[0]?.src || '');
        if (seen.has(key) || key === '') return false;
        seen.add(key);
        return true;
      }).slice(0, 12);

      // Spec 테이블
      document.querySelectorAll('.spec-list li, .spec-table tr, [class*="spec"] li').forEach(row => {
        const label = row.querySelector('.tit, th, dt, [class*="label"]')?.innerText?.trim();
        const value = row.querySelector('.txt, td, dd, [class*="value"]')?.innerText?.trim();
        if (label && value) result.specs.push({ label, value });
      });

      return result;
    });

    return data;
  } finally {
    await browser.close();
  }
}

/* ──────────────────────────────────────────
   2. Claude API — 모듈 매핑
────────────────────────────────────────── */
async function generateModules(crawledData) {
  // Amazon A+ 모듈 정의 & 글자 수 제한
  const moduleGuide = `
Available Amazon A+ Content Modules and their text limits:

STANDARD MODULES:
- "standard-image-header": Full-width banner image (970×300). headline: 150 chars, body: 6000 chars
- "highlights": Left 300×300 image + center text (headline: 150, subhead×3: 80 each, body×3: 500 each) + right bullet list (header: 80, bullets: 200 each, max 8)
- "standard-four-image-text": 4 images (180×180 each). module_headline: 150, per image: title 80, body 300
- "standard-three-image-text": 3 images (310×300 each). module_headline: 150, per image: title 80, body 150
- "standard-single-left-image": Large image left (300×400), text right. headline: 160, body: 6000
- "standard-single-right-image": Large image right (300×400), text left. headline: 160, body: 6000
- "standard-text": Text only. headline: 150 (optional), body: 6000
- "standard-tech-specs": Spec table, 4-16 rows. column headers + spec rows (label+value pairs)
- "standard-comparison-table": 3-product comparison. headline: 80, features: max 5

Use these to map LG PDP content into an ordered list of A+ modules.

Rules:
- Landscape image (ratio > 1.2): use standard-image-header, highlights, standard-four-image-text, standard-three-image-text
- Portrait image (ratio < 0.85): use standard-single-left-image or standard-single-right-image
- Square image (ratio 0.85~1.2): use highlights, standard-four-image-text
- Text with bullet list: use highlights
- Multiple feature images (3-4): use standard-three-image-text or standard-four-image-text
- If specs available: add standard-tech-specs at end
- Alternate left/right image placement for visual rhythm
- Keep original text as close as possible; only trim if over character limit
`;

  const prompt = `You are an Amazon A+ Content specialist for LG Electronics.

Based on the crawled LG.com PDP data below, generate an ordered list of Amazon A+ content modules.

${moduleGuide}

CRAWLED PDP DATA:
${JSON.stringify(crawledData, null, 2)}

Return a JSON array of modules in this exact format:
[
  {
    "moduleId": "highlights",
    "headline": "...",
    "subheads": ["...", "...", "..."],
    "bodies": ["...", "...", "..."],
    "bulletTitle": "...",
    "bullets": ["...", "...", "..."],
    "imageUrl": "https://...",
    "imageAlt": "...",
    "imageRatio": "landscape|portrait|square"
  },
  {
    "moduleId": "standard-image-header",
    "headline": "...",
    "body": "...",
    "imageUrl": "https://...",
    "imageAlt": "..."
  },
  ...
]

Fields vary by moduleId:
- standard-image-header: moduleId, headline, body, imageUrl, imageAlt
- highlights: moduleId, headline, subheads[], bodies[], bulletTitle, bullets[], imageUrl, imageAlt
- standard-four-image-text: moduleId, headline, items[{imageUrl, imageAlt, title, body}]
- standard-three-image-text: moduleId, headline, items[{imageUrl, imageAlt, title, body}]
- standard-single-left-image: moduleId, headline, body, imageUrl, imageAlt
- standard-single-right-image: moduleId, headline, body, imageUrl, imageAlt
- standard-text: moduleId, headline, body
- standard-tech-specs: moduleId, specs[{label, value}]

IMPORTANT:
- Only return valid JSON array, no markdown, no explanation
- Use actual image URLs from the crawled data
- Keep text as close to original as possible
- Truncate only if exceeding character limits
- Generate 5-8 modules minimum`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0].text.trim();
  // JSON만 추출
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude returned non-JSON response');
  return JSON.parse(jsonMatch[0]);
}

/* ──────────────────────────────────────────
   3. API 엔드포인트
────────────────────────────────────────── */
app.post('/api/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  console.log(`\n[1/3] Crawling: ${url}`);
  try {
    const crawledData = await crawlLGPDP(url);
    console.log(`[2/3] Crawled ${crawledData.features.length} feature sections`);

    const modules = await generateModules(crawledData);
    console.log(`[3/3] Generated ${modules.length} A+ modules`);

    res.json({ success: true, modules, crawledData });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ──────────────────────────────────────────
   /api/analyze  — LG.com PDP 섹션 추출
   Claude 없이 크롤링만 수행, 섹션 순서 보존
────────────────────────────────────────── */
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--disable-blink-features=AutomationControlled', '--disable-web-security',
           '--lang=en-US,en']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    // Full HD 1920×1080 — PC 데스크톱 레이아웃 강제 (모바일 이미지 회피, 고해상도 srcset 선택)
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ① 페이지 로드 (networkidle 실패 허용)
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      console.warn('goto networkidle2 warning, retrying domcontentloaded:', e.message);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
      catch (e2) { console.warn('goto domcontentloaded warning (continuing):', e2.message); }
    }

    // ② JS 렌더링 대기 (SPA hydration)
    await new Promise(r => setTimeout(r, 4000));

    // ③ 404 / 에러 페이지 감지 (LG SPA는 URL 유지, DOM에 에러 표시)
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    const titleLower = pageTitle.toLowerCase();

    // H1 텍스트 + LG 전용 에러 클래스 감지
    const pageCheck = await page.evaluate(() => {
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      // LG 전용: error-common class
      const hasLGError = !!document.querySelector('.error-common, #lgContents.error-common, [class*="error-common"]');
      // 에러 페이지 키워드
      const body100 = document.body?.innerText?.substring(0, 200) || '';
      return { h1, hasLGError, body100 };
    }).catch(() => ({ h1: '', hasLGError: false, body100: '' }));

    const h1Lower = pageCheck.h1.toLowerCase();
    const bodyLower = pageCheck.body100.toLowerCase();

    const is404 =
      pageCheck.hasLGError ||
      titleLower.includes("404") ||
      titleLower.includes("not found") ||
      h1Lower.includes("we're sorry") ||
      h1Lower.includes("page you requested") ||
      h1Lower.includes("not available") ||
      h1Lower.includes("page not found") ||
      (bodyLower.includes("we're sorry") && bodyLower.includes("page"));

    if (is404) {
      return res.status(400).json({
        error: `페이지를 찾을 수 없습니다. URL을 확인해주세요.\n(URL: ${finalUrl})`
      });
    }
    console.log(`[analyze] 페이지 로드: ${finalUrl} | ${pageTitle} | H1: ${pageCheck.h1.substring(0, 60)}`);

    // ③-b lazy-load 이미지 강제 활성화 (IntersectionObserver 미작동 대비)
    try {
      await page.evaluate(() => {
        // LG AEM placeholder 패턴 감지 (transparent.png 등 비표준 포함)
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src','data-lazy-src','data-original','data-lazy','data-srcset','data-lazy-srcset'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (!val) return;
            if (attr.includes('srcset')) { if (!img.srcset) img.srcset = val; return; }
            if (isPlaceholderSrc(img)) img.src = val;
          });
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
    } catch (e) { console.warn('Force lazy-load warning:', e.message); }

    // ④ 쿠키/동의 배너 강제 제거
    try {
      await page.evaluate(() => {
        const COOKIE_SELS = [
          '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk',
          '[id*="onetrust"]', '[class*="onetrust"]',
          '[id*="cookie"]', '[class*="cookie-banner"]', '[class*="cookie-consent"]',
          '[id*="consent"]', '[class*="consent-"]',
          '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
          '.ReactModal__Overlay', '.modal-overlay',
        ];
        COOKIE_SELS.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
        });
        // position:fixed 고zIndex 오버레이 제거
        document.querySelectorAll('*').forEach(el => {
          try {
            const s = window.getComputedStyle(el);
            if ((s.position === 'fixed' || s.position === 'sticky') &&
                +s.zIndex > 500 && el.offsetHeight > 80) el.remove();
          } catch (_) {}
        });
        document.body.style.overflow = 'auto';
      });
    } catch (e) { console.warn('Cookie removal warning:', e.message); }

    // ⑤ 스크롤 → lazy-load 이미지 활성화 (페이지 이탈 대비 try/catch)
    try {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let pos = 0;
          const step = 400;
          const t = setInterval(() => {
            window.scrollBy(0, step);
            pos += step;
            if (pos >= document.body.scrollHeight) {
              clearInterval(t);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 100);
          setTimeout(() => { clearInterval(t); resolve(); }, 12000);
        });
      });
      // 스크롤 후 재차 lazy-load 강제 실행 (스크롤로 IntersectionObserver 트리거 후 data-src 잔여분 처리)
      await page.evaluate(() => {
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src','data-lazy-src','data-original','data-lazy'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (val && isPlaceholderSrc(img)) img.src = val;
          });
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
      await new Promise(r => setTimeout(r, 3000)); // 이미지 로딩 안정화 (2s → 3s)
    } catch (e) {
      console.warn('Scroll warning (continuing):', e.message);
      await new Promise(r => setTimeout(r, 1500));
    }

    // ⑤-b 캐러셀/슬라이더 숨겨진 슬라이드 이미지 수집
    // ⚠️ position/left/top/transform 변경 금지:
    //    변경 시 슬라이드가 수직으로 쌓여 컨테이너 height 폭발 → Strategy 1 필터 제거됨
    //    → 개별 슬라이드가 독립 섹션으로 추출, 그루핑(cardItems) 로직이 작동 안 됨
    try {
      await page.evaluate(() => {
        // display:none인 슬라이드만 block으로 전환 (position/transform은 절대 변경 안 함)
        [
          '[class*="swiper-slide"]', '[class*="slick-slide"]',
          '[class*="carousel-item"]', '[class*="owl-item"]',
          '[class*="-slide"]', '[role="tabpanel"]',
          '[aria-roledescription="slide"]',
          '[class*="tab-content"]', '[class*="tab-panel"]',
        ].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            const cs = window.getComputedStyle(el);
            // display:none만 block으로 전환 (그 외 상태는 건드리지 않음)
            if (cs.display === 'none') el.style.setProperty('display', 'block', 'important');
            // visibility/opacity만 조정 (이미지 로딩 트리거용)
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            // ❌ position, left, top, transform → 변경 금지
          });
        });
        // ❌ 래퍼 overflow/transform 변경 금지 (height 왜곡 원인 제거)

        // 새롭게 활성화된 슬라이드의 lazy 이미지 src 직접 주입
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (val && isPlaceholderSrc(img)) img.src = val;
          });
          const lazySrcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || '';
          if (lazySrcset && !img.srcset) img.srcset = lazySrcset;
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
      await new Promise(r => setTimeout(r, 2500)); // 슬라이드 이미지 로딩 대기
    } catch (e) {
      console.warn('Carousel force warning:', e.message);
    }

    // ⑥ DOM 분석
    const features = await page.evaluate(() => {

      // ── 헬퍼 함수 ──────────────────────────────────────
      const SKIP_KW = [
        // 쿠키/동의
        'cookie', 'consent', 'privacy policy', 'manage preference',
        'we use cookies', 'gdpr', 'terms of use',
        // 계정/인증
        'sign in', 'sign up', 'log in', 'create account', 'register',
        'newsletter', 'subscribe',
        // 네비게이션
        'navigation', 'skip to', 'go to homepage', "can't find",
        "page you requested", "page isn't available",
        'search', 'cart', 'checkout', 'wishlist',
        'breadcrumb', 'page not', "we're sorry",
        // 목록 UI
        'view all', 'see all', 'load more', 'show more',
        'sort by', 'filter', 'results',
        // 리뷰/서포트/연락처
        'write a review', 'customer review', 'questions?', 'let us help',
        'contact us', 'find locally', 'find nearby', 'store locator',
        'find a store', 'product support', 'manuals',
        // e-커머스 노이즈
        'limited quantity', 'almost sold out', 'add to cart',
        'summary-member', 'buy now', 'shop now',
        // 추천/관련상품
        'recommended product', 'related product', 'you may also',
        'customers also', 'people also',
        // 리뷰/폼
        'required field', 'ratings', 'write your review', 'overall rating',
        // 기타 노이즈
        'find locally', 'find nearby', 'geolocation',
        'get directions', 'directions to',
        'summary-member', 'limited quantity',
        'limited time', 'offer expires',
        'check your final price', 'final price',
        'what people are saying', 'customer rating',
        'be the first to review', 'first to review',
        'add to compare', 'remove compare',
        'to properly experience', 'use an alternate browser',
        'response to coronavirus', 'covid',
        'passwords must', 'characters left',
        'component-obs', 'iw_component', 'component-update',
        'learn more', // 단독으로 오는 경우
        // AR/360° 뷰어 UI 노이즈
        'experience this product around', 'ar experience',
        'view in your room', 'view in room', '360° view',
        // 소셜/공유 UI
        'share this page', 'share on', 'follow us',
        // 추천/프로모션/지원 노이즈
        'our picks for you', 'picks for you',
        'need more help', 'more help with your product',
        'discover our latest', 'latest promotions', 'latest offers',
        'see all promotions', 'view promotions',
        // LG SA / 지원·FAQ·추천 섹션 (PDP 본문 외 노이즈)
        'frequently asked', 'all spec', 'find the best lg',
        'best qned tv for', 'gaming portal turns', 'find a store',
        'find an installer', 'need help?',
      ];
      function isSkip(text) {
        // \xa0(non-breaking space), \t 등 공백 정규화
        const t = (text || '').replace(/[\xa0\t]+/g, ' ').toLowerCase().trim();
        return SKIP_KW.some(kw => t.includes(kw));
      }

      // CSS 클래스 이름처럼 보이는 텍스트 감지
      // e.g. "component-update-nickname-title", "component-OBScountrySelectDesc"
      function looksLikeClassName(text) {
        if (!text) return false;
        const t = text.trim();
        // 공백 없고 하이픈+영숫자 패턴 (kebab-case or camelCase+hyphen)
        if (/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+){1,}$/.test(t)) return true;
        // 전체가 camelCase (소문자시작 + 대문자 섞임, 공백 없음)
        if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+$/.test(t)) return true;
        return false;
      }

      // 네비게이션 카테고리 목록처럼 보이는 불릿 감지
      function looksLikeNavBullet(text) {
        if (!text) return false;
        // \n\t\n 패턴 (메뉴 항목) 또는 너무 많은 줄바꿈
        if ((text.match(/\n/g) || []).length > 3) return true;
        // TV/AUDIO/VIDEO 같은 카테고리 패턴
        if (/^[A-Z\/&]+(\s[A-Z\/&]+)*$/.test(text.trim())) return true;
        return false;
      }

      // ── 상대 URL → 절대 URL 변환 (핵심 버그 수정) ──────────────
      function abs(u) {
        if (!u) return '';
        u = u.trim();
        if (u.startsWith('data:') || u.startsWith('blob:')) return u;
        if (u.startsWith('//')) return location.protocol + u;
        if (u.startsWith('/'))  return location.origin + u;
        if (!u.startsWith('http')) {
          try { return new URL(u, location.href).href; } catch (_) {}
        }
        return u;
      }

      // srcset 문자열에서 최고 해상도 URL 파싱 (w디스크립터·x디스크립터 모두 지원)
      function parseBestSrcset(ss) {
        if (!ss) return '';
        let bestScore = -1, bestUrl = '';
        ss.split(',').forEach(part => {
          const tokens = part.trim().split(/\s+/);
          const u = tokens[0];
          if (!u) return;
          const descriptor = tokens[1] || '';
          let score = 0;
          if (/^\d+w$/i.test(descriptor)) {
            score = parseInt(descriptor);            // 1440w → 1440
          } else if (/^[\d.]+x$/i.test(descriptor)) {
            score = parseFloat(descriptor) * 1000;  // 2x → 2000 (w보다 낮은 우선순위)
          } else {
            score = 500; // 디스크립터 없는 단독 URL → 중간 우선순위
          }
          if (score > bestScore) { bestScore = score; bestUrl = u; }
        });
        return abs(bestUrl);
      }

      // <source> 가 데스크톱(PC)/모바일 타겟인지 분류
      //   desktop : min-width: 600px+ 가 명시된 경우
      //   mobile  : max-width: 1024px 이하만 있고 min-width 미명시
      //   neutral : media 속성 없음 또는 양쪽 모두 명시
      function classifySource(srcEl) {
        const media = (srcEl.getAttribute('media') || '').toLowerCase();
        if (!media) return 'neutral';
        const minMatch = media.match(/min-width\s*:\s*(\d+)px/);
        const maxMatch = media.match(/max-width\s*:\s*(\d+)px/);
        if (minMatch && parseInt(minMatch[1]) >= 600) return 'desktop';
        if (maxMatch && !minMatch && parseInt(maxMatch[1]) <= 1024) return 'mobile';
        return 'neutral';
      }

      // URL이 모바일 변형 패턴인지 추정
      //   - -M.jpg / _M.png / -m.webp 등 단일 문자 토큰
      //   - -mobile- / _mobile- / /mobile/ 등 명시적 키워드
      //   - -sp.jpg (일본식: smartphone)
      function isMobileUrlPattern(u) {
        if (!u) return false;
        return /[-_]M\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)
            || /[-_]mobile([-_./])/i.test(u)
            || /\/mobile\//i.test(u)
            || /[-_]sp\.(jpe?g|png|webp)(\?|$)/i.test(u);
      }

      // 모바일 URL → 데스크톱 변형 추정 URL
      //   -M.jpg → -D.jpg, -mobile- → -desktop-, -sp.jpg → -pc.jpg
      function guessDesktopUrl(u) {
        if (!u) return u;
        return u
          .replace(/([-_])M(\.(jpe?g|png|webp|gif)(\?|$))/i, (m, sep, ext) => sep + 'D' + ext)
          .replace(/([-_])mobile([-_./])/gi, '$1desktop$2')
          .replace(/\/mobile\//gi, '/desktop/')
          .replace(/([-_])sp(\.(jpe?g|png|webp)(\?|$))/i, '$1pc$2');
      }

      // <picture> 또는 같은 컨테이너 내에서 데스크톱 변형 URL이 실제로 존재하는지 확인
      function existsInDom(url, scope) {
        if (!url || !scope) return false;
        try {
          const html = scope.innerHTML || '';
          // 절대 URL이면 path 부분만 비교
          let needle = url;
          try { needle = new URL(url, location.href).pathname; } catch (_) {}
          return html.indexOf(needle) !== -1;
        } catch (_) { return false; }
      }

      // src가 placeholder(투명 1px 등)인지 판별
      function isSrcPlaceholder(img) {
        const src = img.getAttribute('src') || img.src || '';
        if (!src) return true;
        if (img.naturalWidth <= 1) return true; // 1×1 투명 png / 아직 미로드(0px)
        return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(src)
            || src.endsWith('.gif');
      }

      // srcset / picture에서 최고 해상도 URL 추출 — PC(데스크톱) 이미지 최우선
      function bestSrc(img) {
        // 1) <picture> 안의 <source>에서 PC > neutral > mobile 순으로 선택
        //    srcset(IDL) 또는 data-srcset 모두 탐색 (lazy-load 전/후 모두 대응)
        const picture = img.closest('picture');
        if (picture) {
          const sources = Array.from(picture.querySelectorAll('source'));
          // 미디어쿼리 기반 우선순위 그룹핑 (data-srcset 까지 srcset에 채움)
          const desktopSrcs = sources.filter(s => classifySource(s) === 'desktop');
          const neutralSrcs = sources.filter(s => classifySource(s) === 'neutral');
          const mobileSrcs  = sources.filter(s => classifySource(s) === 'mobile');
          const orderedGroups = [desktopSrcs, neutralSrcs, mobileSrcs];

          // 그룹별로 webp → 타입없음 → 나머지 순으로 탐색
          for (const group of orderedGroups) {
            if (!group.length) continue;
            for (const preferType of ['image/webp', '', null]) {
              for (const src of group) {
                if (preferType !== null && src.getAttribute('type') !== preferType) continue;
                const ss = src.srcset || src.getAttribute('srcset') || src.getAttribute('data-srcset') || '';
                const u = parseBestSrcset(ss);
                if (u) return u;
              }
            }
          }
        }

        // 2) img의 srcset / data-srcset
        const imgSrcset = img.srcset || img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        let fromSrcset = parseBestSrcset(imgSrcset);
        if (fromSrcset) {
          // 모바일 패턴이면 데스크톱 변형이 같은 picture/parent 안에 존재하는지 확인 후 교체
          if (isMobileUrlPattern(fromSrcset)) {
            const desk = guessDesktopUrl(fromSrcset);
            const scope = picture || img.closest('section, article, .component, .c-list__item, .c-floating-contents, .c-media-contents') || img.parentElement;
            if (desk !== fromSrcset && existsInDom(desk, scope)) return desk;
          }
          return fromSrcset;
        }

        // 3) data-src 우선 (naturalWidth ≤ 1 = placeholder or not-loaded → data-src가 실제 URL)
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                        img.getAttribute('data-original') || img.getAttribute('data-lazy') || '';
        if (lazySrc && isSrcPlaceholder(img)) {
          if (isMobileUrlPattern(lazySrc)) {
            const desk = guessDesktopUrl(lazySrc);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== lazySrc && existsInDom(desk, scope)) return desk;
          }
          return abs(lazySrc);
        }

        // 4) currentSrc (브라우저가 선택한 실제 URL)
        if (img.currentSrc && !isSrcPlaceholder(img)) {
          const cs = abs(img.currentSrc);
          if (isMobileUrlPattern(cs)) {
            const desk = guessDesktopUrl(cs);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== cs && existsInDom(desk, scope)) return desk;
          }
          return cs;
        }

        // 5) src — placeholder 패턴 제외
        const src = img.src || '';
        if (src && !isSrcPlaceholder(img)) {
          const sa = abs(src);
          if (isMobileUrlPattern(sa)) {
            const desk = guessDesktopUrl(sa);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== sa && existsInDom(desk, scope)) return desk;
          }
          return sa;
        }

        // 6) data-src fallback (placeholder이더라도 data-src 있으면 사용)
        if (lazySrc) return abs(lazySrc);

        // 7) src 속성 최후 fallback
        return abs(img.getAttribute('src') || '');
      }

      // 이미지와 가장 인접한 텍스트(heading/caption/desc) 추출
      function findNearImageText(img, root) {
        // 0) AEM: c-hero-banner / c-floating-contents / .component.type-X (LG SA) 구조
        //    img → .c-hero-banner__media → .c-floating-contents → c-text-contents
        //    img → .c-media-contents → .c-list__item → .c-text-contents (column-N 카드)
        let cur = img.parentElement;
        for (let i = 0; i < 8; i++) {  // depth 6 → 8 (LG SA 더 깊은 wrapper 대응)
          if (!cur || cur === root) break;
          const cls = (cur.className || '').toString();
          // AEM banner / floating-contents / LG SA component 컨테이너 감지
          if (/c-hero-banner|c-floating|c-text-contents|c-list__item|c-media-contents|component\s/.test(cls) || cur.tagName === 'SECTION') {
            // 이 컨테이너 내 AEM bodycopy 우선
            const bodyP = cur.querySelector('[class*="__bodycopy"] .cmp-text p, [class*="bodycopy"] p, .cmp-text p');
            if (bodyP) {
              const t = bodyP.innerText?.trim();
              if (t && t.length > 10 && !t.startsWith('*')) return t;
            }
            // AEM headline
            const hlEl = cur.querySelector('[class*="__headline"] .cmp-title, .cmp-title__text, .cmp-title');
            if (hlEl) {
              const t = hlEl.innerText?.trim();
              if (t && t.length > 2 && t.length < 200) return t;
            }
          }
          cur = cur.parentElement;
        }

        // 1) <figure> > <figcaption>
        const fig = img.closest('figure');
        if (fig) {
          const cap = fig.querySelector('figcaption')?.innerText?.trim();
          if (cap && cap.length > 2) return cap;
        }
        // 2) 같은 컨테이너의 h3/h4/p (이미지 다음 형제 또는 부모 형제)
        const parent = img.parentElement;
        if (parent) {
          // 형제 중 텍스트 요소 (heading 우선)
          const headingSib = Array.from(parent.children).find(sib => {
            if (sib === img) return false;
            const tag = sib.tagName;
            return tag === 'H2' || tag === 'H3' || tag === 'H4';
          });
          if (headingSib) {
            const t = headingSib.innerText?.trim();
            if (t && t.length > 2 && t.length < 200) return t;
          }
          // 형제 중 텍스트 요소
          for (const sib of Array.from(parent.children)) {
            if (sib === img) continue;
            const t = sib.innerText?.trim();
            if (t && t.length > 2 && t.length < 200) return t;
          }
          // 부모의 형제에서 찾기
          const grandP = parent.parentElement;
          if (grandP && grandP !== root) {
            for (const sib of Array.from(grandP.children)) {
              if (sib.contains(img)) continue;
              const el = sib.querySelector('h2,h3,h4,[class*="__headline"],[class*="-title"],[class*="-desc"]');
              const t = el?.innerText?.trim();
              if (t && t.length > 2 && t.length < 200) return t;
            }
          }
        }
        // 3) img alt 텍스트 (마지막 fallback)
        return img.alt?.trim() || '';
      }

      function extractImgs(root) {
        const rawImgs = [];

        // 1) 일반 <img> 태그
        Array.from(root.querySelectorAll('img')).forEach(img => {
          const src = bestSrc(img);
          if (!src) return;
          // naturalWidth ≤ 1은 placeholder 크기 → 실제 이미지 크기가 아니므로 0으로 처리
          // (크기 필터 'width < 150' 오판 방지)
          const isPlaceholderLoaded = img.naturalWidth <= 1;
          const w = isPlaceholderLoaded ? (+img.getAttribute('width') || 0)
                                        : (img.naturalWidth || +img.getAttribute('width') || 0);
          const h = isPlaceholderLoaded ? (+img.getAttribute('height') || 0)
                                        : (img.naturalHeight || +img.getAttribute('height') || 0);
          const nearText = findNearImageText(img, root);
          rawImgs.push({ url: src, width: w, height: h,
                   ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0,
                   alt: img.alt || '', nearText });
        });

        // 2) <video poster="..."> 포스터 이미지
        Array.from(root.querySelectorAll('video[poster]')).forEach(v => {
          const poster = v.getAttribute('poster') || '';
          if (poster && !poster.startsWith('data:')) {
            rawImgs.push({ url: poster, width: 0, height: 0, ar: 1.78, alt: 'Video poster', nearText: '' });
          }
        });

        // 3) YouTube / Vimeo iframe 썸네일
        Array.from(root.querySelectorAll('iframe')).forEach(iframe => {
          const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
          const ytMatch = src.match(/youtube(?:-nocookie)?\.com\/embed\/([^?&/"]+)/);
          const vimeoMatch = src.match(/vimeo\.com\/video\/(\d+)/);
          if (ytMatch) {
            const vid = ytMatch[1];
            rawImgs.push({
              url: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
              width: 480, height: 360, ar: 1.33, alt: 'Video', nearText: ''
            });
          } else if (vimeoMatch) {
            // Vimeo는 API가 필요하므로 placeholder URL 사용 (로드 시 대체)
          }
        });

        // 4) data-youtube-id / data-video-id 속성 (커스텀 플레이어)
        Array.from(root.querySelectorAll('[data-youtube-id],[data-video-id],[data-vid]')).forEach(el => {
          const vid = el.dataset.youtubeId || el.dataset.videoId || el.dataset.vid;
          if (vid && /^[a-zA-Z0-9_-]{8,12}$/.test(vid)) {
            rawImgs.push({
              url: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
              width: 480, height: 360, ar: 1.33, alt: 'Video', nearText: ''
            });
          }
        });

        // 5) CSS background-image — root 및 모든 하위 요소 스캔 (full-bleed 섹션 대응)
        const bgCandidates = [root, ...Array.from(root.querySelectorAll('*'))];
        bgCandidates.forEach(el => {
          try {
            if (el.offsetWidth < 200 || el.offsetHeight < 80) return; // 너무 작은 요소 제외
            const bg = window.getComputedStyle(el).backgroundImage;
            if (!bg || bg === 'none') return;
            // 여러 레이어 중 첫 url() 추출
            const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
            if (match) {
              const bgUrl = abs(match[1]);
              if (bgUrl && !bgUrl.startsWith('data:') &&
                  !/icon|logo|\.svg|gradient|pixel|1x1|sprite/.test(bgUrl)) {
                rawImgs.push({
                  url: bgUrl,
                  width: el.offsetWidth,
                  height: el.offsetHeight,
                  ar: el.offsetWidth > 0 && el.offsetHeight > 0
                    ? +(el.offsetWidth / el.offsetHeight).toFixed(3) : 0,
                  alt: el.getAttribute('aria-label') || el.title || '',
                  nearText: ''
                });
              }
            }
          } catch (_) {}
        });

        // 6) 카드 패턴 명시 수집 — h3/h4 + img 반복 구조 (carousel, tab, grid card)
        // 이미 수집된 URL 세트
        const collectedUrls = new Set(rawImgs.map(i => i.url.replace(/[?#].*/, '')));
        const CARD_SELS = [
          '[class*="card"]', '[class*="swiper-slide"]', '[class*="slick-slide"]',
          '[class*="-slide"]', '[class*="-item"]', '[class*="-panel"]',
          '[class*="tab-content"]', 'li',
        ];
        CARD_SELS.forEach(sel => {
          try {
            Array.from(root.querySelectorAll(sel)).forEach(card => {
              if (card.offsetHeight < 50 || card.offsetWidth < 80) return;
              // 카드 내에 heading이 있어야 의미 있는 카드
              if (!card.querySelector('h2,h3,h4,h5,strong,[class*="title"],[class*="tit"],[class*="heading"]')) return;
              const cardImg = card.querySelector('img');
              if (!cardImg) return;
              const src = bestSrc(cardImg);
              if (!src) return;
              const baseUrl = src.replace(/[?#].*/, '');
              if (collectedUrls.has(baseUrl)) return;
              collectedUrls.add(baseUrl);
              const w = cardImg.naturalWidth  || +cardImg.getAttribute('width')  || 0;
              const h = cardImg.naturalHeight || +cardImg.getAttribute('height') || 0;
              const nearText = findNearImageText(cardImg, root);
              rawImgs.push({ url: src, width: w, height: h,
                ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0,
                alt: cardImg.alt || '', nearText });
            });
          } catch (_) {}
        });

        // 필터링
        const filtered = rawImgs.filter(i => {
          if (!i.url || i.url.startsWith('data:')) return false;
          const u = i.url.toLowerCase();
          if (/icon|logo|\.svg|blank|placeholder|spinner|pixel|rating|star/.test(u)) return false;
          const filename = u.split('/').pop() || '';
          if (/^loading|[-_]loading[-_.]|loading\.(gif|png|webp)$/.test(filename)) return false;
          // 아이콘 크기 패턴: _24x24.png 같은 경우
          if (/_(\d{1,2})x(\d{1,2})\.(png|jpg|gif|webp)/.test(u)) return false;
          // naturalWidth가 0이면 아직 로딩 전 → URL 패턴이 괜찮으면 허용
          // naturalWidth가 있으면 150px 미만 아이콘 제외
          if (i.width > 0 && i.width < 150) return false;
          // URL에 고해상도 힌트가 있으면 (1600, 1920 등) 명백히 콘텐츠 이미지
          const isHighRes = /[_-](1\d{3}|2\d{3})x/.test(u) || u.includes('/large/') || u.includes('/full/');
          if (isHighRes) return true;
          return true;
        });

        // 중복 제거
        const seen = new Set();
        return filtered.filter(i => {
          const key = i.url.replace(/[?#].*/, '').replace(/-\d{2,4}x\d{2,4}/, '');
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }

      function extractText(root) {
        // ── Eyebrow (AEM: 헤드라인 위의 짧은 카테고리 태그라인) ──
        let eyebrow = '';
        const eyebrowEl = root.querySelector(
          '[class*="__eyebrow"] .cmp-text, [class*="__eyebrow"]');
        if (eyebrowEl) {
          const t = eyebrowEl.innerText?.trim();
          if (t && t.length > 1 && t.length < 100 && !isSkip(t)) eyebrow = t;
        }

        // ── Headline ──
        let hl = '';
        const hlSels = [
          // AEM 전용
          '[class*="__headline"] .cmp-title__text', '[class*="__headline"] .cmp-title',
          '.cmp-title__text', '.cmp-title',
          // 일반
          'h2', 'h3', '[class*="-title"]:not(button)',
          '[class*="-tit"]:not(button)', '[class*="heading"]',
          '.tit', '.title', '.kv-title'
        ];
        for (const sel of hlSels) {
          const el = root.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t.length >= 3 && t.length < 200 &&
              !isSkip(t) && !looksLikeClassName(t)) {
            hl = t; break;
          }
        }

        // ── Subheadline ──
        let sub = '';
        for (const sel of ['h3', 'h4', '[class*="sub-title"]', '[class*="subtitle"]', '.sub-tit']) {
          const el = root.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t !== hl && t.length >= 3 && t.length < 200 &&
              !looksLikeClassName(t)) { sub = t; break; }
        }

        // ── Body copy ──
        // 1) AEM 전용 bodycopy 셀렉터 우선
        let body = '';
        const aemBodySels = [
          '[class*="__bodycopy"] .cmp-text p',
          '[class*="bodycopy"] .cmp-text p',
          '[class*="__bodycopy"] .cmp-text',
          '[class*="bodycopy"] p',
          '.cmp-text p',
          '.cmp-text',
        ];
        for (const aemSel of aemBodySels) {
          const els = Array.from(root.querySelectorAll(aemSel));
          const texts = els
            .map(el => el.innerText?.trim())
            .filter(t => t && t.length > 20 && t.length < 1000 &&
                        !isSkip(t) && !looksLikeClassName(t) && !t.startsWith('*'));
          if (texts.length > 0) { body = texts.slice(0, 3).join('\n'); break; }
        }

        // 2) AEM bodycopy 없으면 일반 p/desc (depth 제한 완화: 15)
        if (!body) {
          const bodyEls = Array.from(root.querySelectorAll(
              'p, [class*="-desc"], [class*="-body"], [class*="-text"], [class*="description"]'))
            .filter(el => {
              let depth = 0, cur = el;
              while (cur && cur !== root && depth < 16) { cur = cur.parentElement; depth++; }
              return depth < 15;
            });
          body = bodyEls
            .map(el => el.innerText?.trim())
            .filter(t => t && t.length > 20 && t.length < 1000 &&
                        !isSkip(t) && !looksLikeClassName(t) && !t.startsWith('*'))
            .slice(0, 3).join('\n');
        }

        // ── Footnotes (* 로 시작하는 p 태그) → body에 덧붙이기 ──
        const footnotes = Array.from(root.querySelectorAll('p, [class*="footnote"], [class*="disclaimer"]'))
          .map(el => el.innerText?.trim())
          .filter(t => t && t.startsWith('*') && t.length > 10 && t.length < 500)
          .slice(0, 2);
        if (footnotes.length > 0) {
          body = (body ? body + '\n' : '') + footnotes.join('\n');
        }

        // ── Bullets ──
        const bullets = Array.from(root.querySelectorAll('li'))
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 3 && t.length < 200 &&
                       !isSkip(t) && !looksLikeNavBullet(t))
          .slice(0, 8);

        // eyebrow는 sub로 활용 (sub 없을 때)
        return { hl, sub: sub || eyebrow, body, bullets };
      }

      // ── 섹션 후보 선정 ────────────────────────────────
      // 헤더/푸터/내비 조상 요소 감지
      function isNavOrFooter(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          const tag = cur.tagName?.toLowerCase();
          if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
          const cls = (cur.className || '').toLowerCase();
          const id = (cur.id || '').toLowerCase();
          if (/\b(header|footer|nav|navigation|breadcrumb|sitemap)\b/.test(cls)) return true;
          // pdp-specs-section 이후 섹션 (review, FAQ, 추천상품 등) 제외
          if (/review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store/i.test(id)) return true;
          if (/review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store/i.test(cls)) return true;
          // LG PDP 전용: pdp-review, pdp-faq, pdp-support 등
          if (/pdp-(review|faq|support|recommend|compare|bundle|accessory)/i.test(id)) return true;
          if (/pdp-(review|faq|support|recommend|compare|bundle|accessory)/i.test(cls)) return true;
          cur = cur.parentElement;
        }
        return false;
      }

      // 전략 1: LG 전용 클래스 셀렉터 (가장 정확)
      // 중첩 요소 필터 — 리스트 내 다른 요소의 자손인 경우 제거 (래퍼 vs 리프 구분)
      function filterLeafNodes(els) {
        return els.filter(el =>
          els.every(other => other === el || !other.contains(el))
        );
      }

      const SPECIFIC_SELS = [
        // ─── LG DE/EU AEM: c-wrapper (이미지+텍스트가 함께 포함된 단위) ──────
        // LG DE에서는 c-wrapper가 type-bg-image(이미지) + c-floating-contents(텍스트)를
        // 모두 포함하는 최상위 feature 단위. .component 보다 먼저 매칭해야 함.
        '#pdp-overview-section > .c-wrapper, #pdp-overview-section .c-wrapper',

        // ─── LG SA/GCC/Middle East — .component (AEM single class) ─────────
        // LG SA 모든 섹션이 <div class="component ..."> 단위로 분리됨
        //   - .component.type-{pdp|default|gallery|overlay|slim|text}
        //   - .component.column{2|3|4}, .component.standard
        //   - .component (단독, modifier 없음)도 valid 콘텐츠 섹션
        // → main#contents 또는 #pdp-overview-section 안의 .component 만 선택해
        //   네비/푸터/추천 섹션 노이즈 제외, DOM order 보존
        'main#contents .component, #pdp-overview-section .component, [id="contents"] .component',

        // ─── 구형 LG SA / module-item 패턴 (legacy) ──────────────────────
        '.module-item', '.module-kv', '.module-feature', '[class*="module-item"]',

        // ─── LG Levant / 구형 사이트 ──────────────────────────────────────
        '.iw_component', '.component-wrap', '.feature-area',

        // ─── LG UK/EU AEM: c-floating-contents (feature 섹션 단위) ─────────
        // ⚠️ [class*="c-X"] 와일드카드 최소화:
        //    c-hero-banner → __media, __content 자식도 매칭 → 조기 종료 버그
        //    c-media → .c-media__image 등 매칭 → 동일 문제
        // → 정확한 클래스명(.c-floating-contents)만 사용, 와일드카드는 제거
        '.c-floating-contents',
        '.c-product-feature',
        '.c-info-section',
        '.c-media-carousel__item',

        // ─── LG AEM 공통 teaser ───────────────────────────────────────────
        '.cmp-teaser', '[class*="cmp-teaser"]',
        '.cmp-container > .container', '.aem-container',

        // ─── LG UK/EU 일반 ────────────────────────────────────────────────
        '.pdp-feature-item', '.pdp-feature-section', '.product-feature', '.product-benefit',
        '[class*="feature-item"]', '[class*="feature-block"]', '[class*="feature-section"]',

        // ─── LG US ────────────────────────────────────────────────────────
        '.pdp-feature', '[class*="pdp-feature"]',

        // ─── LG 공통 ──────────────────────────────────────────────────────
        '.kv-area', '.kv-feature', '.highlight__item', '.highlight-item',
        '[class*="highlight"][class*="item"]',
        '[class*="reason"][class*="item"]',
        '[class*="benefit"][class*="item"]',

        // ─── AEM section 단위 ─────────────────────────────────────────────
        '[class*="feature"][class*="section"]',

        // ─── 일반 fallback ─────────────────────────────────────────────────
        '.cont-inner', '.inner-container', '.feature-list__item',
      ];

      let sections = [];

      // Strategy 1: LG 전용 셀렉터 — 이미지가 있는 섹션을 최소 1개 이상 포함해야 채택
      for (const sel of SPECIFIC_SELS) {
        try {
          const raw = Array.from(document.querySelectorAll(sel))
            .filter(el => el.offsetHeight > 80 && el.offsetWidth > 100 && !isNavOrFooter(el));
          const found = filterLeafNodes(raw).filter(el => {
            if (el.offsetHeight < 3000) return true;
            // 캐러셀/탭 컨테이너는 슬라이드 그루핑을 위해 더 큰 높이 허용
            const hasCarousel = el.querySelector(
              '[class*="swiper"],[class*="slick"],[class*="carousel"],[class*="-slide"]'
            );
            return hasCarousel && el.offsetHeight < 8000;
          });
          if (found.length >= 2) {
            // 이미지가 포함된 섹션이 하나 이상 있어야 채택 (텍스트 전용 셀렉터 오매칭 방지)
            const hasImgSection = found.some(el => el.querySelectorAll('img').length > 0 || (() => {
              const bg = window.getComputedStyle(el).backgroundImage;
              return bg && bg !== 'none' && bg.includes('url(');
            })());
            if (hasImgSection) {
              sections = found;
              console.log('[analyze] selector:', sel, found.length);
              break;
            }
          }
        } catch (_) {}
      }

      // 전략 2: iw_section 직계 자식 기반 (LG Levant 구조 대응)
      if (sections.length < 2) {
        const iwRoot = document.querySelector('.iw_viewport-wrapper, .iw_section, [class*="iw_section"]');
        if (iwRoot) {
          const candidates = Array.from(iwRoot.querySelectorAll('.iw_component, .component-wrap > *, div[class*="GPC"]'))
            .filter(el => el.offsetHeight > 100 && el.offsetWidth > 200 &&
                          !isNavOrFooter(el) && el.querySelector('h2,h3'));
          if (candidates.length >= 1) {
            sections = filterLeafNodes(candidates);
            console.log('[analyze] iw-component strategy:', sections.length);
          }
        }
      }

      // 전략 3: 컨텐츠 스코어링 — Strategy 1 결과와 무관하게 항상 보완 실행
      // 이유: Strategy 1이 gram Link 카드(c-floating-contents 클래스 공유)를 먼저 찾아
      //       feature-04~06 같은 핵심 섹션이 누락되는 구조적 문제 방지
      {
        const pageRoot = document.querySelector('main, [role="main"], #main, .main-content, .pdp-main, .iw_viewport-wrapper') || document.body;
        const candidates = Array.from(pageRoot.querySelectorAll(
          'section, article, [class*="section"], [class*="block"], [class*="feature"], [class*="banner"], div[class]'
        )).filter(el =>
          el.offsetHeight > 120 && el.offsetHeight < 4000 &&
          el.offsetWidth > 300 && !isNavOrFooter(el)
        );
        const scored = candidates.map(el => {
          const imgCount = el.querySelectorAll('img').length;
          const hasBgImg = (() => {
            try {
              const bg = window.getComputedStyle(el).backgroundImage;
              return bg && bg !== 'none' && bg.includes('url(') &&
                     el.offsetWidth > 400 && el.offsetHeight > 150;
            } catch (_) { return false; }
          })();
          const hasHl  = !!el.querySelector('h1,h2,h3,h4');
          const hasTxt = (el.innerText?.trim().length || 0) > 30;
          const score  = (imgCount > 0 ? 3 : 0) + (hasBgImg ? 3 : 0) + (hasHl ? 2 : 0) + (hasTxt ? 1 : 0);
          return { el, score };
        }).filter(s => s.score >= 3).sort((a, b) => b.score - a.score);

        if (scored.length >= 2) {
          const scoredSections = filterLeafNodes(scored.map(s => s.el));
          if (sections.length < 2) {
            // Strategy 1/2 실패: Strategy 3을 주 전략으로 사용
            sections = scoredSections;
            console.log('[analyze] content-score primary:', sections.length);
          } else {
            // Strategy 1/2 성공: Strategy 3을 보완으로 사용 (누락된 섹션 추가)
            const existing = new Set(sections);
            const additional = scoredSections.filter(el =>
              !existing.has(el) &&
              // Strategy 1 섹션과 부모-자식 관계가 아닌 것만 추가
              !sections.some(s => s.contains(el) || el.contains(s))
            );
            if (additional.length > 0) {
              sections = [...sections, ...additional];
              console.log('[analyze] content-score supplement:', additional.length, 'added');
            }
          }
        }
      }

      // 전략 4: 페이지 루트 직계 자식 (최후 fallback)
      if (sections.length < 2) {
        const mainEl = document.querySelector('main, [role="main"], #main');
        if (mainEl) {
          sections = Array.from(mainEl.children)
            .filter(el => !['SCRIPT','STYLE','NAV','HEADER'].includes(el.tagName) &&
                          el.offsetHeight > 100 && !isNavOrFooter(el));
          console.log('[analyze] fallback main children:', sections.length);
        }
      }

      // ── 서브섹션 분할 헬퍼 ──────────────────────────────────────────────────
      // 하나의 섹션에 여러 H2 그룹(카드 row, 탭 그룹 등)이 있을 때 분할
      function trySplitSection(sec) {
        const h2list = Array.from(sec.querySelectorAll('h2')).filter(h => {
          const t = h.innerText?.trim() || '';
          return t.length >= 5 && t.length < 300 && !isSkip(t) && !looksLikeClassName(t);
        });
        if (h2list.length < 2) return null;

        // 각 H2를 포함하는 sec의 직접 자식 컨테이너를 찾기
        const seenContainers = new Set();
        const groups = [];
        h2list.forEach(h => {
          let cur = h;
          // sec의 직접 자식까지 올라가기
          while (cur.parentElement && cur.parentElement !== sec) cur = cur.parentElement;
          const container = (cur === sec) ? h.parentElement : cur;
          if (!container || container === sec) return;
          if (seenContainers.has(container)) return;
          seenContainers.add(container);
          groups.push(container);
        });

        // 유효한 그룹 (충분한 콘텐츠) 필터링
        const valid = groups.filter(g =>
          g.offsetHeight > 80 &&
          (g.querySelectorAll('img').length > 0 || (g.innerText?.trim().length || 0) > 40)
        );
        if (valid.length >= 2) return valid;

        // Fallback: sec의 직접 자식 중 heading + (img or 텍스트) 포함하는 블록
        const children = Array.from(sec.children).filter(child =>
          child.offsetHeight > 80 &&
          child.querySelector('h2,h3,h4') &&
          (child.querySelectorAll('img').length > 0 || (child.innerText?.trim().length || 0) > 40)
        );
        if (children.length >= 2) return children;

        return null;
      }

      // ── 카드 그룹 이미지 + 텍스트 추출 헬퍼 ──────────────────────────────
      // 섹션 내 반복 카드(h3/h4+img 패턴)를 모두 모아 items 배열로 반환
      function extractCardItems(sec) {
        // 카드 아이템을 담는 컨테이너 후보 (swiper/slick 포함)
        const CARD_CONTAINER_SELS = [
          // 캐러셀/슬라이더 래퍼 (최우선 — swiper-slide의 직접 부모)
          '[class*="swiper-wrapper"]', '[class*="swiper-container"]',
          '[class*="slick-track"]', '[class*="slick-list"]',
          // LG SA AEM: c-list / cmp-carousel (column-N 내부)
          '.c-list', '.c-list.swiper-wrapper', '.cmp-carousel',
          '.carousel.panelcontainer',
          // 일반 카드 컨테이너
          '[class*="card-list"]', '[class*="cards"]',
          '[class*="tab-content"]', '[class*="slide-content"]',
          '[class*="items"]', '[class*="grid"]', 'ul',
        ];
        // 카드 아이템 후보 (offsetHeight 무조건 체크)
        const CARD_ITEM_SELS = [
          '[class*="swiper-slide"]', '[class*="slick-slide"]',
          // LG SA: c-list__item (swiper-slide와 함께 등장하지만 단독 매칭도 지원)
          '.c-list__item',
          '[class*="card"]', '[class*="-slide"]', '[class*="-item"]', 'li',
        ];
        let cards = [];

        // 1) 카드 컨테이너 → 직접 자식 카드 탐색
        for (const cSel of CARD_CONTAINER_SELS) {
          const cont = sec.querySelector(cSel);
          if (!cont) continue;
          for (const iSel of CARD_ITEM_SELS) {
            const items = Array.from(cont.querySelectorAll(':scope > ' + iSel))
              // offsetHeight > 0 (display:block으로 전환된 슬라이드는 높이 있음)
              .filter(el => el.offsetHeight > 0 && el.querySelector('img'));
            if (items.length >= 2) { cards = items; break; }
          }
          if (cards.length >= 2) break;
        }

        // 2) 컨테이너 없으면 섹션 전체에서 비직접 자식까지 탐색
        if (cards.length < 2) {
          for (const iSel of CARD_ITEM_SELS) {
            const items = Array.from(sec.querySelectorAll(iSel))
              .filter(el => el.offsetHeight > 0 && el.querySelector('img'));
            if (items.length >= 2) {
              // 최상위 카드만 남기기 (중첩 카드 제거)
              const topLevel = items.filter(el =>
                items.every(other => other === el || !other.contains(el))
              );
              if (topLevel.length >= 2) { cards = topLevel; break; }
            }
          }
        }

        if (cards.length < 2) return null;

        return cards.map(card => {
          const img = card.querySelector('img');
          const src = img ? bestSrc(img) : '';
          // LG SA: .c-text-contents 내부 헤드라인/바디 우선 매핑
          const textContents = card.querySelector('.c-text-contents');
          const lookupRoot = textContents || card;
          // AEM cmp-title 우선, 그 다음 일반 heading
          const titleEl =
            lookupRoot.querySelector('[class*="__headline"] .cmp-title__text, [class*="__headline"] .cmp-title, .cmp-title__text, .cmp-title') ||
            lookupRoot.querySelector('h2,h3,h4,h5,strong,[class*="title"],[class*="tit"]');
          // AEM bodycopy 우선
          const bodyEl =
            lookupRoot.querySelector('[class*="__bodycopy"] .cmp-text p, [class*="bodycopy"] p, .cmp-text p') ||
            lookupRoot.querySelector('p,[class*="desc"],[class*="body"]');
          return {
            imageUrl: src || '',
            title: (titleEl?.innerText || '').trim(),
            body:  (bodyEl?.innerText || '').trim(),
          };
        }).filter(item => item.imageUrl || item.title);
      }

      // ── 섹션 → feature 변환 ────────────────────────────
      const result = [];
      const seenHl  = new Set();
      const seenImg = new Set();
      let featureIdx = 0;

      function processSection(sec, extraImgSources = []) {
        const idx = featureIdx++;
        const { hl, sub, body, bullets } = extractText(sec);

        // 스킵 조건들
        if (isSkip(hl) || isSkip(sub)) return;
        if (looksLikeClassName(hl)) return;
        if (hl && /^[A-Z]{2,}$/.test(hl.trim())) return;
        if (!hl && !body && bullets.length === 0) return;
        if (hl && seenHl.has(hl.toLowerCase())) return;

        // body가 디스클레이머/면책 문구로만 구성된 경우 스킵
        // (예: "Features vary by model", "*Product images...", "Design, features and...")
        const bodyDisclaimerPatterns = [
          /^features vary by model/i,
          /^specifications? (are |is )?subject to (change|modification)/i,
          /^design,?\s*features?\s*(and|&)\s*specifications/i,
          /^\*?actual product may/i,
          /^\*?product images? (in|on) the/i,
          /^\*?the images? (above|in this|on this)/i,
          /^please consult/i,
          /^all images are for illustrative/i,
          /^screen images? (are )?simulated/i,
        ];
        const bodyTrim = (body || '').trim();
        if ((!hl || hl.length < 5) && bodyTrim &&
            bodyDisclaimerPatterns.some(p => p.test(bodyTrim))) return;
        // 헤드라인 없이 body가 *(footnote)로만 시작하면 스킵
        if (!hl && bodyTrim.startsWith('*') && bodyTrim.length < 600) return;

        if (hl) seenHl.add(hl.toLowerCase());

        // 카드 아이템 수집 (3~4장 카드 패턴 우선)
        const cardItems = extractCardItems(sec);

        // 모든 카드의 이미지가 SVG 아이콘이면 지원/메뉴 섹션 → 스킵
        if (cardItems && cardItems.length >= 2 &&
            cardItems.every(c => /\.svg(\?|$)/i.test(c.imageUrl || ''))) return;

        // 카드 제목이 모두 "[N inch] LG ..." 같은 제품 추천 패턴이면 스킵
        // (예: "98 Inch LG UHD UT90 4K Smart TV..." — 추천 상품 캐러셀)
        if (cardItems && cardItems.length >= 3 &&
            cardItems.filter(c =>
              /^\d+\s*("|inch|cm)\s+lg\b/i.test((c.title || '').trim())
            ).length >= Math.ceil(cardItems.length * 0.6)) return;

        // 메인 섹션 + 인접 image-only 형제 섹션의 이미지를 함께 수집
        // (LG SG: section-title 컴포넌트가 이미지 컴포넌트와 형제로 분리되는 케이스 대응)
        const allSrcs = [sec, ...(extraImgSources || [])];
        let imgs = allSrcs.flatMap(s => extractImgs(s))
          .filter(i => !seenImg.has(i.url.replace(/[?#].*/, '')))
          .slice(0, 6);

        // LG DE: 섹션에 이미지가 없으면 부모/형제 컨테이너에서 탐색
        if (imgs.length === 0 && typeof _findParentImages === 'function') {
          const parentImgEls = _findParentImages(sec);
          if (parentImgEls.length > 0) {
            const parentImgs = parentImgEls.map(img => {
              const src = bestSrc(img);
              if (!src || seenImg.has(src.replace(/[?#].*/, ''))) return null;
              const w = img.naturalWidth || +img.getAttribute('width') || 0;
              const h = img.naturalHeight || +img.getAttribute('height') || 0;
              return { url: src, width: w, height: h, ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0, alt: img.alt || '', nearText: '' };
            }).filter(Boolean);
            imgs = parentImgs.slice(0, 4);
          }
        }

        imgs.forEach(i => seenImg.add(i.url.replace(/[?#].*/, '')));

        if (imgs.length === 0 && !hl && (!body || body.length < 80)) return;
        if (imgs.length === 0 && (!body || body.length < 30) && bullets.length < 2) return;
        if (hl && body && imgs.length === 0) {
          const hlNorm = hl.toLowerCase().replace(/\s+/g, ' ');
          const bodyNorm = body.toLowerCase().replace(/\s+/g, ' ');
          if (bodyNorm.split(hlNorm).length > 2) return;
        }

        let cleanBody = body;
        if (hl && body) {
          const hlNorm = hl.toLowerCase().trim();
          const lines = body.split('\n').filter(line => {
            const l = line.toLowerCase().trim();
            return l !== hlNorm && l.length > 0;
          });
          cleanBody = lines.join('\n').trim();
        }

        const sortedImgs = [...imgs].sort((a, b) => {
          const sa = (a.width || 0) + (a.ar >= 0.5 && a.ar <= 4 ? 1000 : 0);
          const sb = (b.width || 0) + (b.ar >= 0.5 && b.ar <= 4 ? 1000 : 0);
          return sb - sa;
        });

        result.push({
          id: `f${idx}`,
          order: idx,
          headline: hl,
          subheadline: sub,
          body: cleanBody,
          bullets,
          images: sortedImgs,
          // 카드 아이템이 있으면 포함 (three-img/four-text 모듈에 직접 매핑)
          cardItems: cardItems && cardItems.length >= 2 ? cardItems : undefined,
        });
      }

      // ── 인접 섹션 병합: title-only ↔ image-only 페어링 ───────────────
      // LG SG/일부 PDP는 section-title 컴포넌트와 이미지 컴포넌트를
      // 형제(sibling)로 분리해 작성. 이를 단일 feature 로 병합해야
      // "Select A+ Content Sections"에서 이미지가 누락되지 않음.
      function _hasMeaningfulImg(s) {
        try {
          // <img> 중 sprite/icon 제외, 실측 ≥ 100×80 또는 picture 안에 있는 것
          const imgs = Array.from(s.querySelectorAll('img'));
          if (imgs.some(i => {
            const src = (i.getAttribute('src') || i.currentSrc || '').toLowerCase();
            if (/icon|logo|sprite|\.svg/.test(src)) return false;
            if (i.closest('picture')) return true;
            const w = i.naturalWidth || +i.getAttribute('width') || 0;
            const h = i.naturalHeight || +i.getAttribute('height') || 0;
            return (w >= 200 && h >= 100);
          })) return true;
          // background-image
          const bg = window.getComputedStyle(s).backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url(') &&
              s.offsetWidth >= 400 && s.offsetHeight >= 200) return true;
          return false;
        } catch (_) { return false; }
      }
      function _hasOwnHeading(s) {
        const hs = Array.from(s.querySelectorAll('h1,h2,h3,h4,.cmp-title__text'));
        return hs.some(h => {
          const t = (h.innerText || '').trim();
          return t.length >= 5 && t.length < 300;
        });
      }
      function _isSectionTitleWrapper(s) {
        // c-wrapper 조상 중 type-section-title 클래스 보유
        let cur = s;
        for (let d = 0; d < 4 && cur; d++, cur = cur.parentElement) {
          const cls = (cur.className || '').toString();
          if (/type-section-title|type-template-title|section-title/.test(cls)) return true;
        }
        return false;
      }

      // DOM 순서로 정렬 (compareDocumentPosition)
      const sectionsInDom = [...sections].sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const mergedInto    = new Map();   // titleSec → [imgOnlySec, ...]
      const consumedAsImg = new Set();   // forEach 단계에서 스킵
      let pendingTitle    = null;
      let stepsSincePending = 0;

      sectionsInDom.forEach(sec => {
        if (consumedAsImg.has(sec)) return;
        const hasH = _hasOwnHeading(sec);
        const hasI = _hasMeaningfulImg(sec);

        if (pendingTitle) {
          stepsSincePending++;
          if (stepsSincePending > 10) { pendingTitle = null; stepsSincePending = 0; }
        }

        if (hasH && !hasI) {
          // title-only 섹션: 다음 image-only 섹션을 기다림
          // primary section-title (c-wrapper.type-section-title) 이 sub-card 의 h2 로
          // 덮어써지지 않도록 우선순위 처리
          const candIsPrimary = _isSectionTitleWrapper(sec);
          const pendIsPrimary = pendingTitle && _isSectionTitleWrapper(pendingTitle);
          if (!pendingTitle || candIsPrimary || !pendIsPrimary) {
            pendingTitle = sec;
            stepsSincePending = 0;
          }
          // pendingTitle 이 primary 인데 candIsPrimary 가 아니면 유지
        } else if (!hasH && hasI && pendingTitle) {
          // image-only 섹션: 가장 최근 pending title 에 흡수
          if (!mergedInto.has(pendingTitle)) mergedInto.set(pendingTitle, []);
          mergedInto.get(pendingTitle).push(sec);
          consumedAsImg.add(sec);
          // 한 title 당 최대 3개 흡수 후 페어링 종료
          if (mergedInto.get(pendingTitle).length >= 3) {
            pendingTitle = null;
            stepsSincePending = 0;
          }
        } else if (hasH && hasI) {
          // 자체적으로 완비된 섹션: pending 종료 — 단, primary pending 은
          // sub-card 자체완비 섹션으로 인해 잃지 않도록 보호
          const pendIsPrimary = pendingTitle && _isSectionTitleWrapper(pendingTitle);
          const candIsPrimary = _isSectionTitleWrapper(sec);
          if (!pendIsPrimary || candIsPrimary) {
            pendingTitle = null;
            stepsSincePending = 0;
          }
        }
      });

      console.log('[analyze] section-title ↔ image-only pairs merged:',
        [...mergedInto.values()].reduce((a, v) => a + v.length, 0));

      // c-floating-contents__floating(텍스트) ↔ __floor(이미지) 동일 부모 페어링
      // LG SG: c-floating-contents 안에서 floating(text) 와 floor(image) 가
      // 형제로 분리되어 있는 케이스. floor 를 extras 로 주입.
      function _findFloatingFloorSibling(sec) {
        try {
          const cls = (sec.className || '').toString();
          if (!cls.includes('c-floating-contents__floating')) return null;
          // 부모 c-floating-contents 탐색
          let parent = sec.parentElement;
          for (let d = 0; d < 4 && parent; d++, parent = parent.parentElement) {
            const pc = (parent.className || '').toString();
            if (pc.includes('c-floating-contents') && !pc.includes('__floating') && !pc.includes('__floor')) {
              break;
            }
          }
          if (!parent) return null;
          // 부모 내 __floor 자손 중 첫 번째
          const floor = parent.querySelector('.c-floating-contents__floor, [class*="c-floating-contents__floor"]');
          if (floor && floor !== sec && !sec.contains(floor)) return floor;
          return null;
        } catch (_) { return null; }
      }

      // ── 섹션에 이미지 없을 때 부모/형제에서 이미지 찾기 ──────────────
      // LG DE: c-floating-contents(텍스트)가 component.type-bg-image(이미지) 안에 중첩
      // 또는 형제 c-wrapper/component에 이미지가 있는 경우
      function _findParentImages(sec) {
        const found = [];
        // 1) 부모 체인에서 이미지를 가진 컨테이너 탐색 (최대 6단계)
        let cur = sec.parentElement;
        for (let d = 0; d < 6 && cur && cur !== document.body; d++, cur = cur.parentElement) {
          // 부모의 모든 img 중 현재 섹션 밖에 있는 것
          const imgs = Array.from(cur.querySelectorAll('img'));
          const outsideImgs = imgs.filter(img => !sec.contains(img));
          outsideImgs.forEach(img => {
            const src = img.src || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) return;
            if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
            const nw = img.naturalWidth || 0;
            if (nw > 0 && nw < 80) return; // tiny icons
            found.push(img);
          });
          if (found.length > 0) break;
          
          // 부모의 background-image도 체크
          try {
            const bg = window.getComputedStyle(cur).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient') &&
                cur.offsetWidth >= 300 && cur.offsetHeight >= 150) {
              // background-image는 img 요소가 아니므로 extractImgs에서 처리됨
              // 여기서는 부모를 extraImgSources에 추가할 수 있도록 마커만 남김
              found._parentContainer = cur;
              break;
            }
          } catch(_) {}
        }
        
        // 2) 같은 부모의 형제(모든 방향) 탐색
        if (found.length === 0) {
          const parent = sec.parentElement;
          if (parent) {
            Array.from(parent.children).forEach(sibling => {
              if (sibling === sec || sec.contains(sibling)) return;
              sibling.querySelectorAll('img').forEach(img => {
                const src = img.src || img.getAttribute('data-src') || '';
                if (!src || src.startsWith('data:')) return;
                if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
                const nw = img.naturalWidth || 0;
                if (nw > 0 && nw < 80) return;
                found.push(img);
              });
            });
          }
        }
        
        // 3) 한 단계 더 위의 부모의 형제도 탐색 (c-wrapper가 형제인 경우)
        if (found.length === 0 && sec.parentElement) {
          const grandParent = sec.parentElement.parentElement;
          if (grandParent && grandParent !== document.body) {
            Array.from(grandParent.children).forEach(sibling => {
              if (sibling.contains(sec)) return;
              sibling.querySelectorAll('img').forEach(img => {
                const src = img.src || img.getAttribute('data-src') || '';
                if (!src || src.startsWith('data:')) return;
                if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
                const nw = img.naturalWidth || 0;
                if (nw > 0 && nw < 80) return;
                found.push(img);
              });
            });
          }
        }
        
        return found;
      }

      sections.forEach(sec => {
        if (consumedAsImg.has(sec)) return;
        const extras = mergedInto.get(sec) || [];
        // floating ↔ floor 페어링 추가
        const floor = _findFloatingFloorSibling(sec);
        if (floor) extras.push(floor);
        // 서브섹션 분할 시도 (H2 그룹이 2개 이상인 경우)
        const subSections = trySplitSection(sec);
        if (subSections) {
          console.log('[analyze] split section →', subSections.length, 'sub-sections');
          subSections.forEach(sub => processSection(sub));
        } else {
          processSection(sec, extras);
        }
      });

      return result;
    });

    console.log(`[analyze] ${url} → ${features.length} features`);
    res.json({ features, url });
  } catch (e) {
    console.error('/api/analyze error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});

/* ── eBay Clone (콘텐츠 추출 + 레이아웃 감지 + HTML 생성) ── */
require('./ebay-clone-handler')(app, puppeteer);

/* ──────────────────────────────────────────
   eBay 전용 PDP 크롤러 — 부모 wrapper 단위로 이미지+텍스트 매칭
   /api/analyze 의 복잡한 섹션 분할 대신,
   wrapper div 단위로 단순하게 이미지+텍스트를 함께 추출
────────────────────────────────────────── */
app.post('/api/ebay-analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--disable-blink-features=AutomationControlled', '--disable-web-security',
           '--lang=en-US,en']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    console.log(`[ebay-analyze] Navigating: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Cookie 동의 클릭
    try {
      const cookieBtn = await page.$('[class*="cookie"] button, [id*="cookie"] button, #onetrust-accept-btn-handler, .accept-all, [class*="consent"] button');
      if (cookieBtn) await cookieBtn.click();
    } catch (_) {}

    // 전체 스크롤 (lazy loading 트리거)
    await page.evaluate(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const totalHeight = document.body.scrollHeight;
      for (let y = 0; y < totalHeight; y += 600) {
        window.scrollTo(0, y);
        await delay(300);
      }
      window.scrollTo(0, 0);
      await delay(1000);
    });

    // lazy-loaded img src 주입
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach(img => {
        ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'].forEach(attr => {
          const val = img.getAttribute(attr);
          if (val && (!img.src || img.naturalWidth <= 1)) img.src = val;
        });
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── 비디오 프레임 캡처 (poster 없는 video → canvas → base64) ──
    const videoFrames = await page.evaluate(async () => {
      const frames = {};
      const videos = document.querySelectorAll('video');
      for (const vid of videos) {
        try {
          const src = vid.src || (vid.querySelector('source')?.src) || '';
          if (!src) continue;
          // 이미 poster가 있으면 스킵
          if (vid.poster || vid.getAttribute('data-poster')) continue;
          // 비디오 로드
          vid.muted = true;
          vid.crossOrigin = 'anonymous';
          if (vid.readyState < 2) {
            vid.load();
            await new Promise(r => {
              vid.addEventListener('loadeddata', r, { once: true });
              setTimeout(r, 3000); // 최대 3초 대기
            });
          }
          // 1초 지점으로 이동
          vid.currentTime = 1;
          await new Promise(r => {
            vid.addEventListener('seeked', r, { once: true });
            setTimeout(r, 2000);
          });
          // canvas에 프레임 그리기
          const w = vid.videoWidth || vid.offsetWidth || 640;
          const h = vid.videoHeight || vid.offsetHeight || 360;
          if (w < 10 || h < 10) continue;
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(w, 800); // 최대 800px
          canvas.height = Math.round(h * (canvas.width / w));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          // tainted canvas 체크 (CORS 오류 시 빈 이미지)
          if (dataUrl && dataUrl.length > 100) {
            frames[src] = dataUrl;
          }
        } catch (e) {
          // CORS or other error — skip
        }
      }
      return frames;
    });
    console.log(`[ebay-analyze] Captured ${Object.keys(videoFrames).length} video frames`);

    // ── 비디오 프레임을 파일로 저장 (eBay 호환용) ──
    const fs = require('fs');
    const path = require('path');
    const framesDir = path.join(__dirname, 'ebay-listing', 'video-frames');
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

    const videoFrameUrls = {};
    Object.entries(videoFrames).forEach(([src, dataUrl], idx) => {
      try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const filename = `frame-${Date.now()}-${idx}.jpg`;
        fs.writeFileSync(path.join(framesDir, filename), Buffer.from(base64, 'base64'));
        videoFrameUrls[src] = `/ebay-listing/video-frames/${filename}`;
      } catch (_) {}
    });

    // ── 섹션 추출 (wrapper 단위) ──
    const videoFrameMap = videoFrameUrls; // pass to evaluate via closure
    const features = await page.evaluate((vfMap) => {
      const SKIP_IDS = /review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store|footer|header|nav|breadcrumb/i;

      function isSkipSection(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (SKIP_IDS.test(cur.id || '') || SKIP_IDS.test(cur.className || '')) return true;
          const tag = cur.tagName?.toLowerCase();
          if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
          cur = cur.parentElement;
        }
        return false;
      }

      function bestImgSrc(img) {
        // picture > source (desktop first)
        const picture = img.closest('picture');
        if (picture) {
          const sources = picture.querySelectorAll('source');
          let best = '';
          sources.forEach(s => {
            const media = s.getAttribute('media') || '';
            const srcset = s.srcset || s.getAttribute('data-srcset') || '';
            if (srcset && (!media || media.includes('min-width'))) {
              best = srcset.split(',')[0].trim().split(' ')[0];
            }
          });
          if (best) return best.startsWith('/') ? location.origin + best : best;
        }
        // direct src
        let src = img.src || img.getAttribute('data-src') || img.currentSrc || '';
        if (src.startsWith('/')) src = location.origin + src;
        return src;
      }

      function getImages(container) {
        const imgs = [];
        const seen = new Set();
        
        // 1) <img> elements
        container.querySelectorAll('img').forEach(img => {
          const src = bestImgSrc(img);
          if (!src || src.startsWith('data:') || seen.has(src)) return;
          if (/icon|logo|sprite|\.svg|1x1|badge|flag/i.test(src)) return;
          if (/loading\.(gif|png|svg)|loading[-_]?(spinner|icon|placeholder|indicator)/i.test(src)) return;
          const nw = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
          if (nw > 0 && nw < 80) return;
          seen.add(src);
          imgs.push({ url: src, alt: img.alt || '', width: nw });
        });
        
        // 2) <video> poster images + captured video frames
        container.querySelectorAll('video').forEach(vid => {
          const poster = vid.poster || vid.getAttribute('data-poster') || '';
          if (poster && !poster.startsWith('data:') && !seen.has(poster)) {
            let url = poster.startsWith('/') ? location.origin + poster : poster;
            seen.add(url);
            imgs.push({ url, alt: 'video poster', width: 0 });
            return;
          }
          // No poster → use captured video frame
          const vidSrc = vid.src || (vid.querySelector('source')?.src) || '';
          if (vidSrc && vfMap[vidSrc] && !seen.has(vfMap[vidSrc])) {
            const frameUrl = location.origin + vfMap[vidSrc];
            seen.add(frameUrl);
            imgs.push({ url: frameUrl, alt: 'video frame', width: 800 });
          }
        });
        
        // 3) background-image on container AND children
        if (imgs.length === 0) {
          const elements = [container, ...Array.from(container.querySelectorAll('*')).slice(0, 50)];
          for (const el of elements) {
            try {
              const bg = window.getComputedStyle(el).backgroundImage;
              if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient')) {
                let bgUrl = bg.match(/url\(["']?(.+?)["']?\)/)?.[1] || '';
                if (bgUrl && !bgUrl.startsWith('data:') && !seen.has(bgUrl)) {
                  if (bgUrl.startsWith('/')) bgUrl = location.origin + bgUrl;
                  // Only add if element is reasonably sized (not tiny icons)
                  if (el.offsetWidth >= 100 && el.offsetHeight >= 60) {
                    seen.add(bgUrl);
                    imgs.push({ url: bgUrl, alt: '', width: el.offsetWidth });
                  }
                }
              }
            } catch (_) {}
            if (imgs.length >= 4) break;
          }
        }
        
        return imgs;
      }

      function getText(container) {
        let headline = '';
        let subheadline = '';
        let body = '';

        const h = container.querySelector('h1, h2, h3, h4, .cmp-title__text');
        if (h) headline = h.innerText?.trim() || '';

        // subheadline: p after h, or smaller heading
        const allH = container.querySelectorAll('h1, h2, h3, h4, h5');
        if (allH.length >= 2) subheadline = allH[1].innerText?.trim() || '';

        // body text from paragraphs
        const ps = container.querySelectorAll('p, .cmp-text, [class*="description"], [class*="body-text"]');
        const bodyParts = [];
        ps.forEach(p => {
          const t = (p.innerText || '').trim();
          if (t.length > 10 && t !== headline && t !== subheadline) bodyParts.push(t);
        });
        body = bodyParts.join('\n').substring(0, 800);

        // bullets
        const bullets = [];
        container.querySelectorAll('li').forEach(li => {
          const t = (li.innerText || '').trim();
          if (t.length > 5 && t.length < 300) bullets.push(t);
        });

        return { headline, subheadline, body, bullets: bullets.slice(0, 8) };
      }

      // ── 1. PDP overview 영역 찾기 ──
      const root = document.querySelector('#pdp-overview-section') ||
                   document.querySelector('[class*="pdp-overview"]') ||
                   document.querySelector('main#contents') ||
                   document.querySelector('main') ||
                   document.body;

      // ── 2. 최상위 wrapper 단위로 섹션 분할 ──
      // 우선순위: c-wrapper > component > section > direct children
      let wrappers = [];

      // Strategy A: c-wrapper (LG DE/EU)
      wrappers = Array.from(root.querySelectorAll(':scope > .c-wrapper, :scope > div > .c-wrapper'));
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll('.c-wrapper'));
      }

      // Strategy B: .component (LG SA/GCC)
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > .component, :scope > div > .component'));
        if (wrappers.length < 2) {
          wrappers = Array.from(root.querySelectorAll('.component'));
        }
      }

      // Strategy C: section tags
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > section, :scope > div > section'));
      }

      // Strategy D: direct div children with meaningful content
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > div')).filter(d =>
          d.offsetHeight > 100 && (d.querySelector('img') || d.querySelector('h2, h3'))
        );
      }

      console.log('[ebay-analyze] Found', wrappers.length, 'wrappers');

      // ── 3. 각 wrapper에서 이미지+텍스트 추출 ──
      const result = [];
      const seenImgs = new Set();
      const seenHeadlines = new Set();

      // 중첩 wrapper 제거 (leaf nodes only)
      const rawLeafWrappers = wrappers.filter(w =>
        !wrappers.some(other => other !== w && other.contains(w))
      ).filter(w => w.offsetHeight > 50 && !isSkipSection(w));

      // 빈/disclaimer wrapper 제거 (ST0010 등: 헤드라인도 이미지도 body도 없는 것)
      const leafWrappers = rawLeafWrappers.filter(w => {
        const text = getText(w);
        const imgs = getImages(w);
        const hasContent = text.headline.length > 3 || text.body.length > 20 || imgs.length > 0;
        return hasContent;
      });

      console.log('[ebay-analyze] leafWrappers after filter:', leafWrappers.length);

      // ── 인접 title-only + image-only wrapper 병합 ──
      // LG DE 패턴: ST0003(title) → ST0001(image) — 이제 빈 ST0010이 제거되어 인접
      const merged = [];
      const consumed = new Set();

      leafWrappers.forEach((w, i) => {
        if (consumed.has(i)) return;
        const imgs = getImages(w);
        const text = getText(w);
        const hasImg = imgs.length > 0;
        const hasText = text.headline.length > 3 || text.body.length > 20;

        // Case 1: title-only → 다음에서 image-only 찾기 (최대 2칸 앞)
        if (hasText && !hasImg) {
          for (let j = i + 1; j < Math.min(i + 3, leafWrappers.length); j++) {
            if (consumed.has(j)) continue;
            const nextImgs = getImages(leafWrappers[j]);
            const nextText = getText(leafWrappers[j]);
            if (nextImgs.length > 0 && nextText.headline.length <= 3) {
              // Merge: title from current + images from next
              // Also merge any body/sub from the image wrapper
              const mergedText = {
                headline: text.headline,
                subheadline: text.subheadline || nextText.subheadline,
                body: text.body || nextText.body,
                bullets: [...text.bullets, ...nextText.bullets].slice(0, 8),
              };
              merged.push({ text: mergedText, imgs: nextImgs });
              consumed.add(j);
              consumed.add(i);
              break;
            }
          }
          if (!consumed.has(i)) {
            // No image partner found, push text-only
            merged.push({ text, imgs: [] });
            consumed.add(i);
          }
          return;
        }

        // Case 2: image-only → 이전에서 title 찾기 (이미 병합 안 된 것)
        if (hasImg && !hasText) {
          // Check if already merged by a title wrapper above
          // If not, push as image-only section
          merged.push({ text, imgs });
          consumed.add(i);
          return;
        }

        // Case 3: both image + text in same wrapper (ideal)
        merged.push({ text, imgs });
        consumed.add(i);
      });

      merged.forEach(({ text, imgs }) => {
        const { headline, subheadline, body, bullets } = text;

        // Skip duplicates and noise
        if (headline && seenHeadlines.has(headline.toLowerCase())) return;
        if (!headline && !body && imgs.length === 0) return;
        if (/cookie|consent|privacy|sign in|newsletter|subscribe/i.test(headline + body)) return;
        if (/WEITERE INFORMATION ZUR COMPLIANCE/i.test(body)) return;

        if (headline) seenHeadlines.add(headline.toLowerCase());

        // Deduplicate images
        const uniqueImgs = imgs.filter(img => {
          const key = img.url.replace(/[?#].*/, '');
          if (seenImgs.has(key)) return false;
          seenImgs.add(key);
          return true;
        });

        result.push({
          headline: headline || '',
          subheadline: subheadline || '',
          body: body || '',
          bullets,
          images: uniqueImgs.slice(0, 4),
        });
      });

      return result;
    }, videoFrameMap);

    console.log(`[ebay-analyze] ${url} → ${features.length} features`);
    res.json({ features, url });
  } catch (e) {
    console.error('[ebay-analyze] error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});

/* ──────────────────────────────────────────
   eBay Listing HTML Generator (Template-based, no AI dependency)
────────────────────────────────────────── */
app.post('/api/ebay-generate', async (req, res) => {
  const { features, url } = req.body;
  if (!features || !features.length) return res.status(400).json({ error: 'features required' });

  try {
    console.log(`[ebay-generate] Building HTML from ${features.length} sections`);

    // ── Helper: ensure HTTPS ──
    function httpsUrl(u) {
      if (!u) return '';
      return u.replace(/^http:\/\//i, 'https://');
    }

    // ── Helper: escape HTML ──
    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Build sections HTML ──
    let sectionsHtml = '';
    let isLeft = true; // alternate image/text layout

    features.forEach((f, idx) => {
      const hl = esc(f.headline || '');
      const sub = esc(f.subheadline || '');
      const body = esc(f.body || '').replace(/\n/g, '<br>');
      const imgs = (f.images || []).filter(img => img.url);
      const bullets = (f.bullets || []).filter(b => b);
      const cards = f.cardItems || [];

      // Skip empty sections
      if (!hl && !body && imgs.length === 0) return;

      // ── Card grid layout (3-4 items) ──
      if (cards.length >= 2) {
        sectionsHtml += `
<div style="padding:30px 0;border-bottom:1px solid #e0e0e0;">
  ${hl ? `<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#1a1a1a;text-align:center;margin:0 0 20px 0;line-height:1.3;">${hl}</h2>` : ''}
  ${sub ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#666;text-align:center;margin:0 0 20px 0;">${sub}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0">
    <tr>
      ${cards.slice(0, 4).map(c => `
        <td style="width:${Math.floor(100/Math.min(cards.length,4))}%;vertical-align:top;padding:0 8px;text-align:center;">
          ${c.imageUrl ? `<img src="${httpsUrl(c.imageUrl)}" alt="${esc(c.title)}" style="width:100%;max-width:250px;height:auto;display:block;margin:0 auto 10px auto;border-radius:4px;">` : ''}
          ${c.title ? `<h3 style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#1a1a1a;margin:0 0 6px 0;line-height:1.3;">${esc(c.title)}</h3>` : ''}
          ${c.body ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#555;margin:0;line-height:1.5;">${esc(c.body).substring(0, 150)}</p>` : ''}
        </td>
      `).join('')}
    </tr>
  </table>
</div>`;
        return;
      }

      // ── Full-width image + text below (primary layout) ──
      const mainImg = imgs[0];
      sectionsHtml += `
<div style="padding:30px 0;border-bottom:1px solid #e0e0e0;">
  ${mainImg ? `<img src="${httpsUrl(mainImg.url)}" alt="${esc(mainImg.alt || hl)}" style="width:100%;max-width:800px;height:auto;display:block;margin:0 auto 20px auto;">` : ''}
  ${hl ? `<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#1a1a1a;margin:0 0 8px 0;line-height:1.3;">${hl}</h2>` : ''}
  ${sub ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#888;margin:0 0 10px 0;">${sub}</p>` : ''}
  ${body ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;margin:0 0 12px 0;line-height:1.7;">${body}</p>` : ''}
  ${bullets.length > 0 ? `<ul style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444;margin:8px 0 0 20px;padding:0;line-height:1.8;">${bullets.slice(0, 6).map(b => `<li style="margin-bottom:4px;">${esc(b)}</li>`).join('')}</ul>` : ''}
  ${imgs.length > 1 ? imgs.slice(1, 3).map(img => `<img src="${httpsUrl(img.url)}" alt="${esc(img.alt)}" style="width:100%;max-width:800px;height:auto;display:block;margin:16px auto 0 auto;">`).join('') : ''}
</div>`;
      isLeft = !isLeft;
    });

    // ── Wrap in eBay-compliant container ──
    const html = `<div style="max-width:800px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#ffffff;color:#333333;">
<!-- LG Product Listing — eBay Compliant HTML -->
<div style="padding:20px 20px 0 20px;">
${sectionsHtml}
<div style="text-align:center;padding:24px 0 16px 0;border-top:1px solid #e0e0e0;">
  <p style="font-size:11px;color:#999;margin:0;">© LG Electronics. All rights reserved.</p>
</div>
</div>
</div>`;

    console.log(`[ebay-generate] Generated ${html.length} chars of eBay HTML`);
    res.json({ success: true, html, charCount: html.length });
  } catch (err) {
    console.error('[ebay-generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ──────────────────────────────────────────
   이미지 프록시 (CORS 우회)
────────────────────────────────────────── */
app.get('/api/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url param');
  try {
    const https = require('https');
    const http = require('http');
    const urlObj = new URL(imageUrl);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const request = protocol.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.lg.com/'
      }
    }, (imgRes) => {
      // 리다이렉트 처리
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        res.redirect(`/api/proxy-image?url=${encodeURIComponent(imgRes.headers.location)}`);
        return;
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      imgRes.pipe(res);
    });
    request.on('error', (e) => {
      console.error('Proxy error:', e.message);
      res.status(500).send(e.message);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅ A+ Content Generator Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ missing'}\n`);
});
