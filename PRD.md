아래 내용 전체를 복사해서 붙여넣기 하세요:

---

```markdown
# 컨텐츠 허브 작업지시서 (Master PRD)

## 전체 시스템 아키텍처

```
[포털 연결]
     ↓
[Module 1] LG.com 크롤러
     ↓
[Module 2] 컨텐츠 라이브러리 (DB)
     ↓
[Module 3] GEO 컨텐츠 생성 엔진
     ↓
[Module 4] 플랫폼 컨텐츠 변환 (Amazon / Shopee)
     ↓
[Module 5] 프리뷰 & 업로드
```

## Module 1: LG.com 크롤러

### Input
- 타겟 GEO: `lg.com/uk`, `lg.com/sg`, `lg.com/de`, `lg.com/sa_en`, `lg.com/th`
- 제품 카테고리: 냉장고, 세탁기, TV, 모니터, 빔프로젝터, 노트북, 오디오, 공기청정기 (전체 가전)

### 크롤 대상 데이터
- 제품명 (모델명 포함)
- 제품 URL
- 카테고리
- 이미지 목록: 이미지 URL / alt 태그 / 이미지 타입 (hero/feature/lifestyle/spec) / 순서(order)
- 상세페이지 텍스트: 헤드라인 / 서브카피 / 스펙·기능 설명
- 키워드 (메타태그, SEO 키워드)

### Output
- `products.json` - 전체 제품 목록
- `{model_id}_data.json` - 제품별 상세 데이터
- `images/{model_id}/` - 이미지 캐시 폴더

### 규칙
- 크롤 주기: 수동 트리거 (필요시 스케줄 추가)
- robots.txt 준수
- 중복 크롤 방지 (마지막 크롤 날짜 기록)
- GEO별 언어 그대로 저장 (번역 X, Module 3에서 처리)

---

## Module 2: 컨텐츠 라이브러리

### 기능
- 제품명/모델명으로 검색
- GEO 필터링
- 카테고리 필터링
- 크롤된 이미지 + alt태그 + 용도태그 시각화
- 원본 상세페이지 텍스트 열람

### 데이터 구조 (DB)
- Product: id / model_id / name / category / geo (uk/sg/de/sa_en/th) / crawled_at
- Images[]: url / alt_tag / image_type (hero/feature/lifestyle/spec) / keywords[]

### Output
- 검색 결과 UI
- 제품 상세 라이브러리 뷰
- 이미지별 메타데이터 표시

---

## Module 3: GEO 컨텐츠 생성 엔진

### Input
- 크롤된 원본 컨텐츠 (Module 2)
- 타겟 GEO 선택
- 타겟 플랫폼 선택 (Amazon / Shopee)

### GEO별 처리 규칙
| GEO | 언어 | 특이사항 |
|-----|------|----------|
| UK | 영어 | 영국식 표현, 영국 규격 |
| SG | 영어 | 싱가포르식 영어, 열대기후 특성 강조 |
| DE | 독일어 | 번역 필요, 독일 규격 |
| SA_EN | 영어 | 중동 문화 반영, 아랍어 병기 고려 |
| TH | 태국어 | 번역 필요, 태국 규격 |

### 생성 컨텐츠
- 현지화된 헤드라인/카피
- 현지화된 이미지 텍스트 오버레이
- 현지 규격·특성 반영된 기능 설명
- SEO 키워드 현지화

---

## Module 4: 플랫폼 컨텐츠 변환

### Amazon 규격
- Main Image: 1500x1500px, 흰 배경, JPEG
- Additional: 1500x1500px, 최대 8장
- A+ Content: 970x300px (배너), 300x300px (모듈)
- Title: 최대 200자
- Bullet Points: 5개, 각 500자 이내
- Description: 2000자 이내

### Shopee 규격
- Main Image: 1:1 비율, 최소 500x500px
- Additional: 최대 9장
- Description: 최대 3000자
- Video: 선택사항

### Output 폴더 구조
```
{model_id}_{geo}_amazon/
├── main_image.jpg
├── additional_01~08.jpg
├── aplus_banner.jpg
├── aplus_modules/
├── title.txt
├── bullet_points.txt
└── description.txt

{model_id}_{geo}_shopee/
├── main_image.jpg
├── additional_01~09.jpg
└── description.txt
```

---

## Module 5: 프리뷰 & 업로드

### 프리뷰 기능
- Amazon 상세페이지 레이아웃으로 미리보기
- Shopee 상세페이지 레이아웃으로 미리보기
- 수정 요청 기능 (재생성 트리거)

### 업로드 옵션
- Option A (API): Amazon SP-API / Shopee Open Platform API로 Draft 상태로 자동 업로드
- Option B (다운로드): 규격에 맞게 생성된 전체 파일 ZIP 다운로드

---

## Skill 구조 (.claude/commands/)

| 파일 | 명령어 | 기능 |
|------|--------|------|
| crawl.md | /crawl | LG.com 크롤링 실행 |
| library.md | /library | 라이브러리 검색/열람 |
| generate.md | /generate | GEO 컨텐츠 생성 |
| amazon.md | /amazon | Amazon 규격 컨텐츠 변환 |
| shopee.md | /shopee | Shopee 규격 컨텐츠 변환 |
| upload.md | /upload | 플랫폼 업로드 or 다운로드 |

---

## 개발 우선순위

1. 폴더 구조 생성 + .claude/commands/ 세팅
2. /crawl skill 개발 & 테스트 (UK부터)
3. 라이브러리 DB 구성
4. /generate skill 개발
5. /amazon, /shopee skill 개발
6. 프리뷰 & 업로드
```
