/**
 * /api/ebay-clone — 이미지+텍스트 추출 → 800px eBay HTML
 * 아마존 A+ 방식: 부모 div 기준으로 이미지/텍스트 그룹핑
 * + 레이아웃 패턴 감지 (히어로, 2분할, 3분할 카드)
 */
module.exports = function registerEbayClone(app, puppeteer) {

app.post('/api/ebay-clone', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--disable-blink-features=AutomationControlled', '--disable-web-security']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    console.log(`[ebay-clone] Navigating: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Cookie
    try {
      const btn = await page.$('#onetrust-accept-btn-handler, [class*="cookie"] button, .accept-all');
      if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 1000)); }
    } catch (_) {}

    // ── Phase 0: 즉시 모든 lazy-load 속성 → 실제 속성으로 강제 복사 (스크롤 전) ──
    await page.evaluate(() => {
      // source data-srcset → srcset
      document.querySelectorAll('source').forEach(src => {
        const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
        if (lazy && !src.srcset) src.srcset = lazy;
      });
      // img data-src → src, data-srcset → srcset
      document.querySelectorAll('img').forEach(img => {
        if (img.loading === 'lazy') img.loading = 'eager';
        ['data-srcset', 'data-lazy-srcset'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (v && !img.srcset) img.srcset = v;
        });
        ['data-src', 'data-lazy-src', 'data-original'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (v && (!img.src || img.src.startsWith('data:') || img.naturalWidth <= 1)) img.src = v;
        });
        // picture > source 에서 데스크톱 URL을 img.src에 직접 주입
        const pic = img.closest('picture');
        if (pic && (!img.src || img.src.startsWith('data:') || img.naturalWidth <= 1)) {
          let bestUrl = '';
          pic.querySelectorAll('source').forEach(s => {
            const media = (s.getAttribute('media') || '').toLowerCase();
            const ss = s.srcset || s.getAttribute('data-srcset') || '';
            if (!ss) return;
            const isDesktop = /min-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/min-width\s*:\s*(\d+)/) || [])[1] || '0') >= 769;
            if (isDesktop) {
              const url = ss.split(',')[0].trim().split(/\s+/)[0];
              if (url) bestUrl = url;
            }
          });
          if (bestUrl) img.src = bestUrl;
        }
      });
    });

    // ── Phase 1: 빠른 전체 스크롤 → IntersectionObserver 트리거 ──
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      // 빠른 1차 스크롤 (800px 간격, 50ms 대기)
      for (let y = 0; y < h; y += 800) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 50));
      }
      window.scrollTo(0, h);
      await new Promise(r => setTimeout(r, 500));
      // 2차 느린 스크롤 (IntersectionObserver 트리거 보장)
      for (let y = 0; y < h; y += 400) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── Phase 2: wrapper 단위 배치 scrollIntoView (개별 img 스크롤 제거 → 10x 속도 개선) ──
    await page.evaluate(async () => {
      const wrappers = document.querySelectorAll('.c-wrapper, .component, [class*="feature"], section');
      for (const w of wrappers) {
        w.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 1500));

    // ── Phase 3: 모든 img에 대해 HTML 속성에서 src 강제 주입 (2차 — 스크롤 후 재실행) ──
    await page.evaluate(() => {
      // source data-srcset → srcset (스크롤 후 새로 활성화된 것 포함)
      document.querySelectorAll('source').forEach(src => {
        const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
        if (lazy && !src.srcset) src.srcset = lazy;
      });

      document.querySelectorAll('img').forEach(img => {
        if (img.loading === 'lazy') img.loading = 'eager';

        // data-src 계열 속성에서 src 주입
        ['data-src', 'data-lazy-src', 'data-original'].forEach(a => {
          const v = img.getAttribute(a);
          if (v && (!img.src || img.src.startsWith('data:') || img.naturalWidth <= 1)) img.src = v;
        });

        // picture > source에서 desktop URL 직접 주입 (media 속성 기반)
        const pic = img.closest('picture');
        if (pic) {
          let desktopUrl = '';
          let fallbackUrl = '';
          pic.querySelectorAll('source').forEach(s => {
            const media = (s.getAttribute('media') || '').toLowerCase();
            const ss = s.srcset || s.getAttribute('data-srcset') || '';
            if (!ss) return;
            const isDesktopMedia = /min-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/min-width\s*:\s*(\d+)/) || [])[1] || '0') >= 769;
            const isMobileMedia = /max-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/max-width\s*:\s*(\d+)/) || [])[1] || '9999') <= 1024;
            ss.split(',').forEach(entry => {
              const url = entry.trim().replace(/\s+\d+[wx]$/i, '').trim();
              if (!url || url.startsWith('data:')) return;
              if (isDesktopMedia || /[-_]d\.|[-_]d[-_]|desktop/i.test(url)) desktopUrl = url;
              else if (!isMobileMedia && !fallbackUrl && !/[-_]m\.|[-_]m[-_]|mobile/i.test(url)) fallbackUrl = url;
            });
          });
          const bestUrl = desktopUrl || fallbackUrl;
          // 항상 bestUrl이 있으면 img.src를 교체 (모바일 fallback 대체)
          if (bestUrl) {
            const absUrl = bestUrl.startsWith('/') ? location.origin + bestUrl : bestUrl;
            img.src = absUrl;
          }
        }

        // img 자체 srcset 에서 src 보강
        const ss = img.srcset || img.getAttribute('data-srcset') || '';
        if (ss && (!img.src || img.src.startsWith('data:') || img.naturalWidth <= 1)) {
          const url = ss.split(',').pop().trim().replace(/\s+\d+[wx]$/i, '').trim();
          if (url) img.src = url;
        }
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── 비디오 프레임 캡처 (desktop만, wrapper당 1개) ──
    const videoFrames = await page.evaluate(async () => {
      const frames = {};
      const captured = new Set();
      const MOBILE_RE = /[-_]m\b|[-_]m\.|[-_]m[-_]|\/mobile\/|[-_]mobile[-_.]/i;
      for (const vid of document.querySelectorAll('video')) {
        try {
          let allSrcs = [vid.src, ...Array.from(vid.querySelectorAll('source')).map(s => s.src)].filter(Boolean);
          if (allSrcs.length === 0) continue;

          // 모바일/태블릿 소스만 있는 비디오 → 스킵
          const desktopSrcs = allSrcs.filter(u => !MOBILE_RE.test(u));
          if (desktopSrcs.length === 0) continue;

          // wrapper 중복 체크
          const wrapper = vid.closest('.c-wrapper, .component, section') || vid.parentElement;
          const wrapperKey = wrapper ? (wrapper.className || '').toString().substring(0, 50) + (wrapper.id || '') : allSrcs[0];
          if (captured.has(wrapperKey)) continue;
          captured.add(wrapperKey);

          vid.muted = true;
          vid.crossOrigin = 'anonymous';
          if (vid.readyState < 2) {
            vid.load();
            await new Promise(r => { vid.onloadeddata = r; setTimeout(r, 4000); });
          }
          vid.currentTime = 1;
          await new Promise(r => { vid.onseeked = r; setTimeout(r, 2000); });
          const w = vid.videoWidth || 640, h = vid.videoHeight || 360;
          const c = document.createElement('canvas');
          c.width = Math.min(w, 800);
          c.height = Math.round(h * (c.width / w));
          c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
          const d = c.toDataURL('image/jpeg', 0.8);
          if (d.length > 200) {
            // 모든 source URL에 같은 프레임 등록 → 매칭 보장
            allSrcs.forEach(u => { frames[u] = d; });
          }
        } catch(_) {}
      }
      return frames;
    });
    console.log(`[ebay-clone] Video frames captured: ${Object.keys(videoFrames).length}`);

    // ── 콘텐츠 추출 ──
    const sections = await page.evaluate((vidFrames) => {
      const O = location.origin;
      const SKIP = /review|faq|recommend|related|support|accessori|compare|bundle|find-a-store|footer|header|nav|breadcrumb|cookie|consent|pdp-specs|installation[-_]?guide/i;

      function abs(u) {
        if (!u) return '';
        if (u.startsWith('//')) return 'https:' + u;
        if (u.startsWith('/')) return O + u;
        return u.replace(/^http:\/\//, 'https://');
      }

      function bestSrc(img) {
        // ── HTML 속성에서 직접 URL 파싱 (로딩 상태 무관) ──
        const desktopUrls = [];
        const neutralUrls = [];
        const mobileUrls = [];

        // 1. picture > source 에서 URL 수집 (media 속성으로 desktop/mobile 분류)
        const pic = img.closest('picture');
        if (pic) {
          pic.querySelectorAll('source').forEach(s => {
            const media = (s.getAttribute('media') || '').toLowerCase();
            const ss = s.srcset || s.getAttribute('data-srcset') || '';
            if (!ss) return;
            const isDesktopMedia = /min-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/min-width\s*:\s*(\d+)/) || [])[1] || '0') >= 769;
            const isMobileMedia = /max-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/max-width\s*:\s*(\d+)/) || [])[1] || '9999') <= 1024;
            ss.split(',').forEach(entry => {
              const url = entry.trim().replace(/\s+\d+[wx]$/i, '').trim();
              if (!url || url.startsWith('data:')) return;
              if (isDesktopMedia) {
                desktopUrls.push(url);
              } else if (isMobileMedia) {
                mobileUrls.push(url);
              } else {
                neutralUrls.push(url);
              }
            });
          });
        }

        // 2. img 자체의 srcset / data-srcset
        const imgSrcset = img.srcset || img.getAttribute('data-srcset') || '';
        if (imgSrcset) {
          imgSrcset.split(',').forEach(entry => {
            const url = entry.trim().replace(/\s+\d+[wx]$/i, '').trim();
            if (url && !url.startsWith('data:')) neutralUrls.push(url);
          });
        }

        // 3. data-src, data-lazy-src, src, currentSrc 순서로 수집
        ['data-src', 'data-lazy-src'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (v && !v.startsWith('data:')) neutralUrls.push(v);
        });
        if (img.src && !img.src.startsWith('data:')) neutralUrls.push(img.src);
        const cur = img.currentSrc || '';
        if (cur && !cur.startsWith('data:')) neutralUrls.push(cur);

        // ── 우선순위: desktop(media query) > desktop(URL 패턴) > neutral > mobile→desktop 변환 ──

        // A) media query로 확정된 데스크톱 URL 최우선
        if (desktopUrls.length > 0) return abs(desktopUrls[0]);

        // B) URL 패턴으로 데스크톱 추정 (-d., -d-, desktop 등)
        const allUrls = [...neutralUrls];
        const patternDesktop = allUrls.find(u => /[-_]d\.|[-_]d[-_]|fc-desktop|[-_]desktop[-_.]/i.test(u));
        if (patternDesktop) return abs(patternDesktop);

        // C) 모바일 패턴이 아닌 URL (neutral)
        const nonMobileUrl = allUrls.find(u => !/[-_]m\.|[-_]m[-_]|fc-mobile|\/mobile\/|[-_]mobile[-_.]/i.test(u));
        if (nonMobileUrl) return abs(nonMobileUrl);

        // D) 모바일 URL → 데스크톱 변환 시도 (-m.jpg → -d.jpg)
        const firstMobile = mobileUrls[0] || allUrls[0];
        if (firstMobile) {
          if (/[-_]m\.(jpg|jpeg|png|webp)/i.test(firstMobile)) {
            return abs(firstMobile.replace(/[-_]m\.(jpg|jpeg|png|webp)/i, '-d.$1'));
          }
          // 변환 불가능하면 모바일이라도 반환 (이미지 없는 것보다 나음)
          return abs(firstMobile);
        }

        return '';
      }

      // 전역 seen Set (모든 wrapper 간 중복 제거)
      const globalSeen = new Set();

      function extractImgs(el) {
        const imgs = [];
        el.querySelectorAll('img').forEach(img => {
          const src = bestSrc(img);
          if (!src || src.startsWith('data:') || globalSeen.has(src)) return;
          if (/icon|logo|sprite|\.svg|1x1|flag/i.test(src)) return;
          if (/loading\.(gif|png|svg)|loading[-_]?(spinner|icon|placeholder)/i.test(src)) return;
          // 모바일 전용 이미지 스킵 — 단, bestSrc()가 picture>source에서 데스크톱을
          // 찾지 못해 모바일 URL을 반환한 경우는 허용 (이미지 없는 것보다 나음)
          // 판별: 같은 picture 안에 데스크톱 source가 있었는지 확인
          const pic = img.closest('picture');
          const hasDesktopSource = pic && Array.from(pic.querySelectorAll('source')).some(s => {
            const media = (s.getAttribute('media') || '').toLowerCase();
            return /min-width\s*:\s*(\d+)/.test(media) &&
              parseInt((media.match(/min-width\s*:\s*(\d+)/) || [])[1] || '0') >= 769;
          });
          if (/[-_]m\.|[-_]m[-_]|fc-mobile|\/mobile\/|[-_]mobile[-_.]/i.test(src)) {
            // 데스크톱 source가 있었지만 bestSrc가 모바일을 반환한 경우 → 허용
            if (!hasDesktopSource) {
              console.log('[skip-mobile]', src.substring(src.lastIndexOf('/') + 1));
              return;
            }
            console.log('[allow-mobile-fallback]', src.substring(src.lastIndexOf('/') + 1));
          }
          // 파일명 기반 중복 제거 (desktop/mobile 변형만 통합, -t는 별도 허용)
          const fname = src.substring(src.lastIndexOf('/') + 1).replace(/[-_](d|m)([-_.])/gi, '_X_$2');
          if (globalSeen.has(fname)) {
            console.log('[skip-dup]', src.substring(src.lastIndexOf('/') + 1));
            return;
          }
          globalSeen.add(src);
          globalSeen.add(fname);
          imgs.push({ url: src, alt: img.alt || '' });
        });
        // background-image fallback
        if (imgs.length === 0) {
          [el, ...Array.from(el.querySelectorAll('*')).slice(0, 20)].forEach(e => {
            try {
              const bg = getComputedStyle(e).backgroundImage;
              if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient')) {
                const m = bg.match(/url\(["']?(.+?)["']?\)/);
                if (m && e.offsetWidth >= 100 && e.offsetHeight >= 60) {
                  const u = abs(m[1]);
                  if (!globalSeen.has(u)) { globalSeen.add(u); imgs.push({ url: u, alt: '' }); }
                }
              }
            } catch(_) {}
          });
        }
        // video → desktop 캡처 프레임 1개만 (모바일 소스 제외)
        let videoAdded = false;
        const MOBILE_VID = /[-_]m\b|[-_]m\.|[-_]m[-_]|\/mobile\/|[-_]mobile[-_.]/i;
        el.querySelectorAll('video').forEach(vid => {
          if (videoAdded) return;
          // desktop source 우선 탐색
          let src = '';
          vid.querySelectorAll('source').forEach(s => {
            const u = s.src || '';
            if (!src && /desktop|[-_]d\.|[-_]d[-_]|[-_]pc[-_.]|fc-desktop/i.test(u)) src = u;
          });
          if (!src) {
            // fallback: 모바일 아닌 첫번째 소스
            const fallback = vid.src || vid.querySelector('source')?.src || '';
            if (!MOBILE_VID.test(fallback)) src = fallback;
          }
          if (src && vidFrames[src] && !globalSeen.has(src)) {
            globalSeen.add(src);
            imgs.push({ url: vidFrames[src], alt: 'video frame', videoSrc: abs(src) });
            videoAdded = true;
          }
        });
        return imgs;
      }

      function extractText(el) {
        const h = el.querySelector('h1,h2,h3,h4,.cmp-title__text');
        const headline = h ? (h.innerText || '').trim() : '';
        const sub = el.querySelector('h3,h4,h5,.cmp-text__subtitle');
        const subheadline = (sub && sub !== h) ? (sub.innerText || '').trim() : '';
        const ps = [];
        el.querySelectorAll('p,.cmp-text,[class*="description"]').forEach(p => {
          const t = (p.innerText || '').trim();
          if (t.length > 10 && t !== headline && t !== subheadline && !ps.includes(t)) ps.push(t);
        });
        const bullets = [];
        el.querySelectorAll('li').forEach(li => {
          const t = (li.innerText || '').trim();
          if (t.length > 5 && t.length < 300 && !bullets.includes(t)) bullets.push(t);
        });
        return { headline, subheadline, body: ps.join(' ').substring(0, 500), bullets: bullets.slice(0, 6) };
      }

      // ── 카드 패턴 감지 ──
      function detectCards(wrapper) {
        const selectors = [
          ':scope > div > div', ':scope > ul > li',
          '.swiper-slide', '[class*="slide"]',
          '[class*="card"]', '[class*="item"]',
        ];
        for (const sel of selectors) {
          const kids = Array.from(wrapper.querySelectorAll(sel))
            .filter(c => c.offsetHeight > 50 && c.offsetWidth > 80);
          if (kids.length >= 2 && kids.length <= 6) {
            const cards = kids.map(k => ({
              imgs: extractImgs(k).slice(0, 1),
              ...extractText(k),
            })).filter(c => c.imgs.length > 0 || c.headline);
            if (cards.length >= 2) return cards;
          }
        }
        return null;
      }

      // Root
      const root = document.querySelector('#pdp-overview-section') ||
                   document.querySelector('#pdp-feature, [class*="feature-area"], [class*="pdp-feature"]') ||
                   document.querySelector('main#contents') ||
                   document.querySelector('main') || document.body;

      // ── wrapper 선택 전략 (LG DE c-wrapper 구조 최적화) ──
      let wrappers = [];

      // Strategy A: c-wrapper (LG DE/EU) — 중첩 제거 개선
      const allCWrappers = Array.from(root.querySelectorAll('.c-wrapper'));
      if (allCWrappers.length >= 3) {
        // 최상위 c-wrapper만 선택 (다른 c-wrapper의 자손인 것 제거)
        wrappers = allCWrappers.filter(w =>
          w.offsetHeight > 50 &&
          !allCWrappers.some(o => o !== w && o.contains(w)) &&
          !SKIP.test(w.id || '') && !SKIP.test((w.className || '').toString())
        );
      }

      // Strategy B: .component (LG SA/GCC)
      if (wrappers.length < 3) {
        const allComponents = Array.from(root.querySelectorAll('.component'));
        const filtered = allComponents.filter(w =>
          w.offsetHeight > 50 &&
          !allComponents.some(o => o !== w && o.contains(w)) &&
          !SKIP.test(w.id || '') && !SKIP.test((w.className || '').toString())
        );
        if (filtered.length >= 3) wrappers = filtered;
      }

      // Strategy C: other selectors
      if (wrappers.length < 3) {
        for (const sel of [
          '[class*="feature-component"]', '[class*="module-component"]',
          ':scope > section', ':scope > div',
          'section[class]', 'div.c-content-area > div'
        ]) {
          const all = Array.from(root.querySelectorAll(sel));
          const filtered = all.filter(w =>
            w.offsetHeight > 50 &&
            !all.some(o => o !== w && o.contains(w)) &&
            !SKIP.test(w.id || '') && !SKIP.test((w.className || '').toString())
          );
          if (filtered.length >= 3) { wrappers = filtered; break; }
        }
      }

      console.log('[ebay-clone] Raw wrappers:', wrappers.length);

      // 빈 wrapper 제거 — picture/source/background-image도 체크
      // (LG DE: img 태그 없이 picture > source만 있는 경우 대응)
      wrappers = wrappers.filter(w => {
        const t = extractText(w);
        const hasImgs = w.querySelectorAll('img, video, picture').length > 0;
        // background-image 체크
        let hasBg = false;
        try {
          const bg = getComputedStyle(w).backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url(') && w.offsetWidth >= 200) hasBg = true;
        } catch(_) {}
        return t.headline.length > 3 || t.body.length > 20 || hasImgs || hasBg;
      });

      console.log('[ebay-clone] Filtered wrappers:', wrappers.length);

      // ── 헬퍼: wrapper에 의미 있는 이미지가 있는지 빠른 체크 ──
      function _hasImages(w) {
        // img/picture/video 포함 여부 (extractImgs 호출 전 가벼운 체크)
        const imgs = w.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || img.getAttribute('data-src') || img.currentSrc || '';
          if (src && !src.startsWith('data:') && !/icon|logo|sprite|\.svg|1x1/i.test(src)) return true;
          // picture > source 확인
          const pic = img.closest('picture');
          if (pic && pic.querySelector('source[srcset], source[data-srcset]')) return true;
        }
        if (w.querySelector('video')) return true;
        // background-image 체크
        try {
          const bg = getComputedStyle(w).backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient') &&
              w.offsetWidth >= 200 && w.offsetHeight >= 100) return true;
        } catch(_) {}
        return false;
      }

      // ── 섹션별 추출 + 인접 wrapper 병합 (title↔image 페어링) ──
      const result = [];
      const seenHL = new Set();
      const consumed = new Set();

      wrappers.forEach((w, idx) => {
        if (consumed.has(idx)) return;

        let imgs = extractImgs(w);
        const text = extractText(w);
        const cards = detectCards(w);
        const hasOwnImages = _hasImages(w);

        // ── title-only wrapper → 전방/후방에서 image-only wrapper 탐색 병합 ──
        if (imgs.length === 0 && !cards && text.headline) {
          // 전방 탐색: 다음 wrapper들 중 image-only (headline 없음) 찾기
          for (let j = idx + 1; j < Math.min(idx + 6, wrappers.length); j++) {
            if (consumed.has(j)) continue;
            const candidateText = extractText(wrappers[j]);
            // disclaimer/빈 wrapper는 건너뛰고 계속 탐색
            if (!candidateText.headline && candidateText.body.length < 30 && !_hasImages(wrappers[j])) continue;
            // headline이 있으면 다른 feature 섹션 → 탐색 중단
            if (candidateText.headline && candidateText.headline.length > 5) break;
            // image-only wrapper 발견 → 병합
            if (_hasImages(wrappers[j]) && !candidateText.headline) {
              const ni = extractImgs(wrappers[j]);
              if (ni.length > 0) {
                imgs = ni;
                text.body = text.body || candidateText.body;
                text.subheadline = text.subheadline || candidateText.subheadline;
                consumed.add(j);
                break;
              }
            }
          }

          // 후방 탐색: 바로 앞 wrapper가 image-only인 경우 (이미 소비되지 않았을 때)
          if (imgs.length === 0 && idx > 0 && !consumed.has(idx - 1)) {
            const prevText = extractText(wrappers[idx - 1]);
            if (_hasImages(wrappers[idx - 1]) && !prevText.headline) {
              const ni = extractImgs(wrappers[idx - 1]);
              if (ni.length > 0) {
                imgs = ni;
                consumed.add(idx - 1);
              }
            }
          }
        }

        // ── image-only wrapper (headline 없음) → 다음 title wrapper의 이미지로 활용 예정 → 스킵 ──
        // (단, 앞/뒤에 title wrapper가 없으면 독립 섹션으로 유지)
        if (imgs.length > 0 && !text.headline && !text.body) {
          // 뒤에 title-only wrapper가 곧 올 가능성 체크
          let willBeMerged = false;
          for (let j = idx + 1; j < Math.min(idx + 4, wrappers.length); j++) {
            if (consumed.has(j)) continue;
            const nt = extractText(wrappers[j]);
            if (nt.headline && !_hasImages(wrappers[j])) {
              willBeMerged = true; // 뒤의 title wrapper가 이 이미지를 가져갈 것
              break;
            }
            if (nt.headline || _hasImages(wrappers[j])) break; // 자체 완비 → 병합 안 됨
          }
          // 앞에서 이미 병합 대상으로 소비되었거나, 곧 병합될 예정이면 여기서 push하지 않고 스킵
          if (willBeMerged) return;
        }

        // 중복/노이즈 필터
        if (text.headline && seenHL.has(text.headline.toLowerCase())) return;
        if (!text.headline && !text.body && imgs.length === 0 && !cards) return;
        if (/COMPLIANCE|WEITERE INFORMATION/i.test(text.body)) return;
        // disclaimer-only 섹션 스킵 (헤드라인 없이 *로 시작하는 짧은 텍스트)
        if (!text.headline && text.body.trim().startsWith('*') && text.body.length < 300 && imgs.length === 0) return;
        if (text.headline) seenHL.add(text.headline.toLowerCase());

        consumed.add(idx);

        // 레이아웃 타입
        let layout = 'text-only';
        if (cards && cards.length >= 2) layout = 'cards-' + Math.min(cards.length, 3);
        else if (imgs.length >= 3) layout = 'image-grid';
        else if (imgs.length > 0 && (text.headline || text.body)) layout = 'image-text';
        else if (imgs.length > 0) layout = 'full-image';

        result.push({
          layout,
          headline: text.headline,
          subheadline: text.subheadline,
          body: text.body,
          bullets: text.bullets,
          images: imgs.slice(0, 6),
          cards: cards ? cards.slice(0, 4).map(c => ({
            headline: c.headline,
            body: c.body ? c.body.substring(0, 150) : '',
            image: c.imgs[0] || null,
          })) : null,
        });
      });

      return result;
    }, videoFrames);

    console.log(`[ebay-clone] Extracted ${sections.length} sections`);
    sections.forEach((s, i) => console.log(`  [${i}] ${s.layout}: "${s.headline || '(no hl)'}" | ${s.images.length} imgs: ${s.images.map(im => im.url.substring(im.url.lastIndexOf('/')+1, im.url.lastIndexOf('/')+40)).join(', ')}${s.cards ? ' | ' + s.cards.length + ' cards' : ''}`));

    // ── 800px eBay HTML 생성 ──
    function e(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // 이미지 태그 생성 (비디오 프레임엔 data-video-src 추가)
    function imgTag(img, style) {
      const vs = img.videoSrc ? ` data-video-src="${e(img.videoSrc)}"` : '';
      const cls = img.videoSrc ? ' class="video-frame"' : '';
      return `<img src="${img.url}" alt="${e(img.alt)}"${vs}${cls} style="${style || 'width:100%;height:auto;display:block;'}">`;
    }

    let body = '';

    sections.forEach((sec, idx) => {
      const divider = idx > 0 ? 'border-top:1px solid #e0e0e0;' : '';

      switch (sec.layout) {
        case 'full-image':
          body += `<div style="padding:5px 0;${divider}">`;
          sec.images.forEach(im => { body += imgTag(im); });
          body += `</div>`;
          break;

        case 'image-text': {
          const imgLeft = idx % 2 === 0;
          body += `<div style="padding:30px 0;${divider}">`;
          body += `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>`;
          const imgTd = `<td style="width:50%;vertical-align:top;padding:0;overflow:hidden;border-radius:6px;">
            <div style="position:relative;width:100%;height:100%;min-height:200px;overflow:hidden;">
              ${imgTag(sec.images[0], 'width:100%;height:100%;object-fit:cover;display:block;border-radius:6px;')}
            </div>
          </td>`;
          const txtTd = `<td style="width:50%;vertical-align:middle;padding:20px 15px;">
            ${sec.headline ? `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1a1a1a;">${e(sec.headline)}</h2>` : ''}
            ${sec.subheadline ? `<div style="margin:0 0 6px;font-size:13px;color:#888;">${e(sec.subheadline)}</div>` : ''}
            ${sec.body ? `<p style="margin:0 0 8px;font-size:13px;color:#444;line-height:1.6;">${e(sec.body)}</p>` : ''}
            ${sec.bullets.length ? `<ul style="margin:8px 0;padding-left:16px;">${sec.bullets.map(b => `<li style="font-size:12px;color:#555;margin-bottom:3px;">${e(b)}</li>`).join('')}</ul>` : ''}
          </td>`;
          body += imgLeft ? imgTd + txtTd : txtTd + imgTd;
          body += `</tr></table>`;
          if (sec.images.length > 1) {
            const extra = sec.images.slice(1, 4);
            body += `<table style="width:100%;border-collapse:collapse;margin-top:8px;"><tr>`;
            extra.forEach(im => {
              body += `<td style="width:${Math.floor(100/extra.length)}%;padding:4px;">${imgTag(im, 'width:100%;height:auto;border-radius:4px;')}</td>`;
            });
            body += `</tr></table>`;
          }
          body += `</div>`;
          break;
        }

        case 'image-grid':
          body += `<div style="padding:20px 0;${divider}">`;
          if (sec.headline) body += `<h2 style="text-align:center;margin:0 0 15px;font-size:20px;color:#1a1a1a;">${e(sec.headline)}</h2>`;
          const gridCols = Math.min(sec.images.length, 3);
          for (let r = 0; r < sec.images.length; r += gridCols) {
            const row = sec.images.slice(r, r + gridCols);
            body += `<table style="width:100%;border-collapse:collapse;"><tr>`;
            row.forEach(im => {
              body += `<td style="width:${Math.floor(100/gridCols)}%;padding:4px;">${imgTag(im, 'width:100%;height:auto;border-radius:4px;')}</td>`;
            });
            body += `</tr></table>`;
          }
          body += `</div>`;
          break;

        case 'cards-2':
        case 'cards-3': {
          const n = sec.cards.length;
          body += `<div style="padding:25px 0;${divider}">`;
          if (sec.headline) {
            body += `<div style="text-align:center;margin-bottom:15px;">
              <h2 style="margin:0;font-size:20px;font-weight:700;color:#1a1a1a;">${e(sec.headline)}</h2>
              ${sec.body ? `<p style="margin:6px 0 0;font-size:13px;color:#666;">${e(sec.body).substring(0, 150)}</p>` : ''}
            </div>`;
          }
          body += `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>`;
          sec.cards.forEach(card => {
            body += `<td style="width:${Math.floor(100/n)}%;vertical-align:top;padding:8px;text-align:center;">`;
            if (card.image) body += imgTag(card.image, 'width:100%;height:auto;border-radius:8px;');
            if (card.headline) body += `<div style="margin-top:8px;font-size:13px;font-weight:700;color:#1a1a1a;">${e(card.headline)}</div>`;
            if (card.body) body += `<div style="margin-top:4px;font-size:11px;color:#666;line-height:1.4;">${e(card.body)}</div>`;
            body += `</td>`;
          });
          body += `</tr></table></div>`;
          break;
        }

        case 'text-only':
        default:
          if (!sec.headline && !sec.body) break;
          body += `<div style="padding:20px;${divider}">`;
          if (sec.headline) body += `<h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1a1a1a;">${e(sec.headline)}</h2>`;
          if (sec.body) body += `<p style="margin:0 0 8px;font-size:13px;color:#444;line-height:1.6;">${e(sec.body)}</p>`;
          if (sec.bullets.length) body += `<ul style="margin:8px 0;padding-left:16px;">${sec.bullets.map(b => `<li style="font-size:12px;color:#555;margin-bottom:3px;">${e(b)}</li>`).join('')}</ul>`;
          body += `</div>`;
          break;
      }
    });

    const finalHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0 auto;padding:0;max-width:800px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;background:#fff;">
${body}
</body></html>`;

    console.log(`[ebay-clone] HTML: ${finalHtml.length} chars`);
    res.json({ html: finalHtml, url, chars: finalHtml.length });
  } catch (err) {
    console.error('[ebay-clone] error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

}; // end module.exports
