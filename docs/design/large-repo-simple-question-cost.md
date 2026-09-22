# 초대형 리포 × 간단한 질문에서 codegraph 비용이 역전되는 문제 (CG-39)

**Status:** Phase 0·1·3 구현 완료, T1.5 A/B 1회차(n=2/팔, 모두 warm) 실행 완료 — 호출 수 3→1~2,
write 토큰 ~40% 감소했으나 비용·시간 통과 기준은 미달(§7.2~7.3). T2.2(상한 5→3)는 보류, S3는
문서 규칙대로 미진행. 남은 항목: 통제 리포 flow 비회귀 A/B(로컬에 excalidraw/vscode 없음), cold↔cold
재측정. 2026-09-02 작성, 2026-09-03 갱신.
**증상 보고:** D:\UnrealEngine (100,956 파일 · 2.1M 노드 · 7.67M 엣지) 에 대해
"프로젝트에 구현된 카메라 시스템에 대해서 알려줘" 를 Claude CLI(`--model sonnet --effort high`,
stream-json)로 실행. codegraph 사용(A) / 미사용(B) 모두 5~7턴에 끝났고 합산 토큰도 비슷했지만,
**A의 비용이 최대 50% 더 높았다.**

관련 문서: `docs/benchmarks/call-sequence-analysis.md` (README A/B의 비용 메커니즘),
`docs/design/explore-session-dedup.md` (CG-17/18 세션 상태 + 크로스콜 dedup),
`docs/benchmarks/explore-dedup-ab-cg20.md` (CG-19 폐기 사유), `docs/design/explore-budget-allocation.md`.

---

## 1. 한 줄 결론

비용 차이는 토큰 **수**가 아니라 토큰 **종류**에서 온다. 에이전트 루프의 합산 토큰은 대부분
값싼 `cache_read`이고, 비용은 **매 턴 새로 들어오는 툴 결과(cache 기록)** 와 **출력 토큰**이
결정한다. codegraph는 초대형 리포에서 호출당 최대 24K chars를 돌려주고, 호출 예산을 5로
잡은 뒤 그 예산을 다 쓰도록 문구로 유도하므로, B가 thrash하지 않는 간단한 질문에서는 A의
신규 토큰만 순증한다.

---

## 2. 과금 모델 (왜 "토큰이 비슷한데 비용이 다른가")

Sonnet 5 기준 단가 (1M 토큰당). Claude Code는 기본 1시간 TTL로 캐시를 기록한다.

| 버킷 | 단가 | `cache_read` 대비 |
|---|---|---|
| `cache_read_input_tokens` | $0.20 | 1x |
| `cache_creation` (5분 TTL) | $2.50 | 12.5x |
| `cache_creation` (1시간 TTL) | $4.00 | **20x** |
| `output_tokens` (thinking 포함) | $10.00 | **50x** |

에이전트 루프에서는 매 턴 컨텍스트 전체를 다시 읽으므로 합산 토큰의 80~95%가 `cache_read`다.
그래서 두 실행의 합산 토큰이 비슷해도 비용은 다음 식으로 갈린다.

```
cost ≈ Σ_turn ( new_tool_result_tokens × 20 + output_tokens × 50 ) × $0.20/M  + cache_read × $0.20/M
```

**측정 지표를 바꿔야 한다.** "총 토큰"이 아니라 `cache_creation` 합계와 `output` 합계를 팔별로
비교해야 원인이 보인다. `scripts/agent-eval/parse-run.mjs`는 현재 네 버킷의 **합계**만 낸다
(`processed`, 326행 부근). 버킷별 분해는 없다.

---

## 3. 원인 분석 (코드 앵커 포함)

### 3.1 호출 예산이 리포 크기에 비례해 커진다. 질문 범위는 그렇지 않다

- `getExploreBudget(fileCount)` (`src/mcp/tools.ts:166`): `<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5`.
  Unreal은 최상위 티어라 **5회**.
- `getExploreOutputBudget` (`src/mcp/tools.ts:240`): ≥15000 티어의 `maxOutputChars` 24,000,
  `hardCeiling = min(24000 × 1.5, 25000)` (`tools.ts:4287`). C++ 소스는 약 3.3 chars/token이므로
  **호출당 약 7K 토큰이 신규 기록**된다.
- 5회면 약 35K 토큰 → 1시간 TTL 기준 **약 $0.14**. B 환경의 Glob/Grep 결과(수백~수천 chars) +
  Read 2~3개와 비교하면 신규 토큰이 수 배다.
- "카메라 시스템 개요"는 리포가 500 파일이든 10만 파일이든 관련 파일 수가 비슷하다. 예산을 파일 수에
  비례시킨 근거는 **flow 질문에서 Read 0을 달성하기 위한 것**이지 개요 질문을 위한 것이 아니다.

### 3.2 출력 문구가 예산을 "상한"이 아니라 "목표"로 읽히게 한다

- 예산 문구 (`tools.ts:5851` 부근):
  > Explore budget: 5 calls for this project (100,956 files indexed). Each call covers ~6 files;
  > if your question spans more, spend your remaining calls on the uncovered area BEFORE falling
  > back to Read … **Synthesize once you've used 5.**
- 툴 설명 접미사 (`tools.ts:1563`): `Budget: make at most 5 calls for this project (…)`.
- "Not shown above — explore these names for their source" 포인터 목록 (`POINTER_HEADER`,
  `tools.ts:871`)은 Unreal에서 항상 길게 나온다(Camera* 파일이 수십 개). 추가 호출을 부추긴다.
- CG-20 A/B 기록에 따르면 explore 직후의 행동 중 **"explore again"이 52~57%** 이고, CG-1은 이를
  "완전한 답 이후의 자발적 드릴다운"으로 분류했다. flow 질문에서는 무해했지만, 간단한 질문에서는
  이 드릴다운이 곧 비용이다.

### 3.3 벤치마크의 비용 이점은 "B가 thrash할 때"만 성립한다

`call-sequence-analysis.md`의 35% 비용 절감은 B가 55~79회 툴 호출로 컨텍스트를 키우며
thrash한 결과다. 5~7턴으로 끝나는 질문에서는 상쇄가 없다. README 벤치 리포는 최대 1만 파일이고
질문은 flow 위주라서 **"≥25K 파일 × 개요 질문" 조합은 검증된 적이 없다.**

### 3.4 기존 dedup(CG-18)은 바이트를 줄이지 않도록 설계돼 있다

`explore-dedup-ab-cg20.md` Bar 4: 재호출에서 이미 보낸 파일을 제외해 절약한 바이트는
**아직 안 보여준 파일에 재배분**된다("Freed budget should flow to files not yet shown, not
shrink the response"). 즉 5회 호출은 항상 5 × 24K에 가깝다. 중복 제거가 비용을 낮추지 못하는 것은
버그가 아니라 설계다.

### 3.5 출력 토큰 (검증 필요)

컨텍스트에 소스가 많을수록 답변과 high effort thinking이 길어지는 경향이 있다. 출력은 캐시 읽기의
50배 단가라 수천 토큰 차이로도 비용이 벌어진다. 로그 버킷 분해로 확정해야 한다.

### 3.6 부수 문제: 시간

Unreal에서 explore 1회는 인덱스 수정 후에도 약 20초(`project_explore_perf_root_cause`).
5회면 100초라 wall-clock 목표(CLAUDE.md: 더 빨라야 함)도 어긋난다.

---

## 4. 해결 방안 분석

각 항목: 기대 효과 · 위험 · 근거 · 검증 방법.

### S1. 예산 문구·툴 설명을 "상한"으로 되돌리기 (저위험, 1순위)

- **변경:** "Synthesize once you've used N" → "답할 수 있으면 즉시 종합하라. 개요·단일 심볼 질문은
  보통 1~2회면 충분하다. 남은 예산은 flow가 끊긴 경우에만 써라." 툴 설명의 `Budget: make at most N`은
  유지하되 상한임을 명시. ≥25K 티어에서는 "Each call covers ~6 files; spend your remaining calls
  BEFORE falling back to Read" 문장을 삭제하거나 flow 조건부로 한정.
- **효과:** 간단한 질문의 호출 수 3~5 → 1~2. 호출당 7K 토큰 × 줄어든 호출 수만큼 기록 비용 감소.
- **위험:** flow 질문에서 Read 폴백 증가. CLAUDE.md의 "adapt the tool to the agent" 원칙상
  문구는 저염성(low-salience) 채널이라 **효과가 작을 수 있다.** 다만 이 변경은 steering을 더하는 게
  아니라 현재 과하게 호출을 미는 문구를 **빼는** 것이므로 원칙과 충돌하지 않는다.
- **근거:** 3.2. 특히 CG-20의 "explore again 57%"는 문구가 실제로 드릴다운을 유발한다는 방증.
- **검증:** §6 프로토콜. 통제군(vscode/excalidraw flow 질문)에서 Read/Grep 비회귀 필수.

### S2. 최상위 티어 호출 예산 캡 재검토 (중위험)

- **변경 후보:** (a) ≥25K 티어 5 → 3 으로 낮춤. (b) 티어 유지하되 예산 문구는 `min(tier, 2)`를
  기본으로 보여주고, flow 섹션이 "끊김"을 보고했을 때만 전체 티어를 노출.
- **효과:** 상한 자체가 낮아져 문구 효과에 기대지 않는다.
- **위험:** vscode(10K, 3회)보다 큰 리포의 flow 질문은 실제로 4~5회가 필요할 수 있다. 데이터 없음.
  CLAUDE.md 표의 ~20K/~40K 티어(4/5회)는 **외삽**이지 측정값이 아니다.
- **근거:** 3.1. 질문 범위가 파일 수에 비례하지 않는다는 관찰.
- **검증:** Unreal에서 flow 질문 1개(예: `APlayerController` → `APlayerCameraManager::UpdateCamera`)로
  3회 예산에서도 end-to-end 연결되는지 확인 후 결정.

### S3. 개요 질문 전용 "지도 모드" 첫 호출 (고위험, A/B 필수)

- **변경:** 질의에 그래프에서 해석되는 심볼 이름이 없고(`buildFlowFromNamedSymbols`의
  `namedNodeIds`가 비어 있음) 자연어 질문 형태일 때, 첫 호출은 파일·심볼 목록 + 짧은 시그니처 창
  (skeleton 렌더링, `adaptive-explore-sizing.md`의 메커니즘 재사용) 위주로 응답하고 본문은 상위
  2~3 파일만. 두 번째 호출부터는 정상.
- **효과:** 개요 질문의 첫 호출 신규 토큰 7K → 2~3K. 에이전트가 이름을 얻어 두 번째 호출을 정밀하게
  던진다.
- **위험:** iter2 실패 사례(`getExploreOutputBudget` 주석: per-file 2.5K로 줄이자 Read 폴백 증가).
  "부분 답변은 무답변보다 나쁘다" 원칙. skeleton 라벨은 이미 "codegraph_explore a name for its
  full body; do NOT Read"로 바뀌어 있으나(`tools.ts:4813`), 개요 질문에서 본문 없는 첫 응답이
  Read 폴백을 부르는지는 별도 검증이 필요하다.
- **근거:** 3.1, 3.4. dedup이 바이트를 줄이지 못하므로 줄이려면 첫 호출의 모드를 바꿔야 한다.
- **검증:** Unreal 개요 질문 3개 × 2회/팔, sufficiency 버킷에서 "Read a file we returned"이 0 유지.

### S4. 포인터 목록의 크기·문구 조정 (저위험)

- **변경:** ≥25K 티어에서 "Not shown above" 항목 수 상한(예: 6)과 "explore these names" 문구를
  "필요할 때만"으로. 이미 답에 충분한 경우 목록이 드릴다운을 유도하지 않도록.
- **위험:** CG-12는 포인터 이름을 load-bearing으로 본다(byte를 withheld한 파일은 반드시 이름을 남김).
  상한을 두면 그 계약이 깨진다. 이름은 남기되 유도 문구만 줄이는 쪽이 안전.
- **검증:** S1과 묶어서.

### S5. 측정 도구: 버킷별 비용 분해 (무위험, 선행 조건)

- **변경:** `parse-run.mjs`와 `compare-arms.mjs`에 `input / cache_creation(5m·1h) / cache_read /
  output` 네 버킷의 토큰과 단가 곱 비용을 추가. 스크래치패드에 검증된 초안이 있다
  (`cost-breakdown.mjs`: message.id 중복 제거, `usage.cache_creation.ephemeral_1h_input_tokens`
  분리, 툴별 결과 chars).
- **효과:** 이후 모든 A/B에서 "어느 버킷이 벌어졌는가"를 바로 읽는다. 3.5(출력 토큰) 가설도 여기서 판정.
- **근거:** 2절. 현재 합산 토큰 지표는 이 문제를 **구조적으로 숨긴다.**

### S6. 검증 매트릭스 확장 (방법론)

- **변경:** `dynamic-dispatch-coverage-playbook.md` §6 매트릭스와 CLAUDE.md 검증 방법론에
  "리포 크기 티어 × 질문 유형(개요 / 단일 심볼 / flow)" 축을 추가. ≥25K 티어 대표 리포로 Unreal
  (또는 공개 리포 chromium/llvm 중 인덱싱 가능한 것) 지정.
- **통과 기준 추가:** 간단한 질문에서 codegraph 팔의 `cache_creation + output` 비용이 B 대비
  **증가하지 않을 것** (동일 턴 수 기준). 시간은 기존대로 더 빨라야 함.

### 검토했지만 제외

- **CG-19 예산 감쇠 재도입:** CG-20 결과로 폐기됨(드릴다운은 불충분 재시도가 아님). 재제안 금지.
  본 문서의 S1/S2는 감쇠가 아니라 상한·문구 조정이다.
- **호스트 캐시 TTL 변경:** Claude Code가 결정하며 codegraph가 관여할 수 없다. 단가 표에는 반영.
- **explore 응답을 파일로 외부화:** 25K 초과 시 호스트가 파일로 빼고 에이전트가 다시 Read하므로
  더 비싸진다(`getExploreOutputBudget` 주석). 현재 24K 캡은 유지.
- **서버 instructions로 질문 유형별 안내 추가:** 저염성 채널. 3가지 문구 변형 실험이 모두 실패한
  기록(CLAUDE.md). S1은 기존 문구를 빼는 것이라 별개.

---

## 5. TODO

체크 표시는 완료 시. 각 항목은 파일 · 테스트 · 완료 기준을 포함한다.

### Phase 0 — 측정 (다른 모든 단계의 선행 조건)

- [x] **T0.1 완료 (2026-09-02)** `scripts/agent-eval/cost-buckets.mjs`로 이관. `MODEL=sonnet|opus|haiku`
  (기본 sonnet — 검증된 단가는 sonnet뿐, opus/haiku는 표준 배수) 또는 `CG_PRICES='{...}'`로 단가 선택.
  `bucketsOf / formatBuckets / formatBucketsBrief`를 export해 `parse-run.mjs`가 같은 코드를 쓴다.
  로그 폴더의 `cost-breakdown.mjs`는 §7.1 재현용 원본으로 그대로 둔다.
  - **output_tokens 신뢰 불가 버그 반영됨:** thinking display가 기본값(`omitted`)일 때 턴당 2~4로
    찍히지만 실제 청구 output/thinking 토큰은 수천 단위(§7.1). `total_cost_usd - (input+write5m+
    write1h+read 비용)`으로 역산한 `output (from cost gap)`을 신뢰값으로 출력.
- [x] **T0.2 완료 (2026-09-02)** `parse-run.mjs`: 결과 요약 아래 `billed buckets` / `bucket cost` 두 줄
  추가(`parseSession().buckets`), self-test에 버킷 케이스 5개 추가(id dedup · 5m/1h 분리 · 비용 역산
  output). `compare-arms.mjs`: "billed token buckets (CG-39)" 블록(write tok · read tok · output
  reconciled · write+output $ · reported $) + 읽는 법에 캐시 윈도우 주의 추가.
  - **확인 결과:** `processed` 합산은 raw `output_tokens`를 더하므로 실제 output만큼 과소평가되나
    (Unreal 실행 기준 ~3.7K / ~195K ≈ 2%), 기존 캠페인과의 비교 가능성을 위해 그대로 두고 주석으로
    명시. 비용 격차를 설명하는 수치는 버킷 줄이다.
- [x] **T0.3 완료 (n=1)** D:\UnrealEngine에서 실제 두 팔을 직접 실행해 분해·기록 완료 — 결과는
  §7.1. 확인된 것: A의 `write1h`가 B의 약 2배(가설과 일치), output 보정값은 A·B 비슷(3.5 가설
  기각), explore 3회 중 2회가 25K자 상한 근처(가설과 일치). **다만 n=1이고, B 실행이 같은 세션에서
  먼저 실행한 오염된 B의 캐시를 물려받아 저렴하게 나온 교란이 있음(§7.1 마지막 항목)** — §6
  프로토콜대로 캐시 윈도우를 분리해 n≥2로 반복해야 정확한 격차를 낼 수 있다. 미완료 항목으로 이월.

### Phase 1 — 저위험 변경 (문구·상한)

- [x] **T1.1 완료 (2026-09-02)** 예산 문구를 `exploreBudgetNote(callBudget, fileCount)`로 추출
  (`src/mcp/tools.ts`, `getExploreBudget` 바로 아래, 근거 주석 포함). 새 문구: "**Explore budget: up to
  N calls …** Answer as soon as you can — an overview or single-symbol question usually needs 1–2
  calls. Spend the remaining calls only when a flow you named did not connect end-to-end, or your
  question spans files this call did not cover; another explore is still cheaper and more complete
  than reading those files." — "Each call covers ~6 files / BEFORE falling back to Read / Synthesize
  once you've used N" 제거.
  - 테스트: `explore-output-budget.test.ts`에 `describe('explore budget wording is a ceiling…')` 3건
    (헬퍼 단위 테스트 — 500+ 파일 픽스처 없이 문구 계약을 고정). 소형 프로젝트 비노출 단언은 그대로.
- [x] **T1.2 완료** `exploreBudgetSuffix()`: "Budget: up to N calls for this project (… files
  indexed); most questions need 1–2." `mcp-tool-annotations.test.ts` 정규식 `/Budget: up to \d+ calls/`.
- [x] **T1.3 완료** `POINTER_HEADER` → "**Not shown above — explore these names if your answer still
  needs them**" (이름 목록·CG-12 계약 그대로, 유도만 조건부). `explore-allocation-1500.test.ts:266`
  문자열 갱신; `explore-reservation-invariant.test.ts`의 `/Not shown above/` 정규식은 그대로 통과.
- [x] **T1.4** `server-instructions.ts` 미변경 (확인).
- [x] **T1.5 (1회차 완료, 2026-09-03)** 빌드 후 Unreal 개요 질문 A/B 2회/팔 실행 — §7.2. explore
  호출 3→1~2(중앙값 1.5, 기준 ≤2 통과), write 토큰 50.7K→17.6~32.2K. **비용 기준(with w+o ≤ without)과
  시간 기준은 미달** — 단 without 팔이 얕은 답(디렉터리 목록/보일러플레이트만 보고 답)을 낸 비대칭이
  있고 n=2. CHANGELOG `[Unreleased] > Fixes`에 1줄 추가함(문구 변경 자체는 출시 대상이고, "호출 수·write
  감소"는 측정으로 뒷받침됨; "without보다 싸다"는 주장은 넣지 않음). **미완료:** 통제 리포(excalidraw/
  vscode) flow 비회귀 A/B — 이 머신에 클론이 없어 실행 못 함. cold↔cold 재측정도 미완(§7.2 각주).

### Phase 2 — 상한·모드 변경 (A/B 게이트)

- [x] **T2.1 완료 (2026-09-02, 100,956 파일 인덱스)** `probe-explore.mjs D:/UnrealEngine
  "APlayerController::PlayerTick UpdateRotation UpdateCameraManager APlayerCameraManager::UpdateCamera
  DoUpdateCamera UpdateViewTarget AActor::CalcCamera"` → Flow 섹션이 **1회 호출**(24,989자, 9초)로
  `UpdateCameraManager → UpdateCamera → DoUpdateCamera → UpdateViewTarget → UpdateViewTargetInternal →
  CalcCamera` 6홉을 end-to-end 연결. (`PlayerTick`/`UpdateRotation`은 같은 경로가 아니라 제외됨 —
  `UpdateCameraManager`의 호출자는 `LevelTick.cpp`.) 짧은 질의("APlayerController UpdateCameraManager
  APlayerCameraManager UpdateCamera")도 1회로 두 파일 본문 + `UpdateCameraManager → UpdateCamera` 엣지
  반환. **결론: 이 flow는 3회 예산으로 충분(1회면 됨). T2.2 진행 가능.**
- [ ] **T2.2 보류 (2026-09-03 결정)** T2.1은 통과했지만 T1.5에서 이미 호출 수가 1~2로 떨어져 5회
  상한이 이 질문에서 구속 조건이 아니게 됐다. 지금 5→3으로 낮추면 이 A/B 기록과 교란되고, 25K 초과
  리포의 긴 flow에 대한 측정값은 여전히 없다. 다음 flow A/B(Unreal 카메라 flow 질문, 에이전트 실행)에서
  실제 호출 수가 ≤3으로 나오면 그때 낮춘다. `explore-output-budget.test.ts` 티어 경계 단언은 그대로.
- [x] **T2.3 결정: S3 진행하지 않음.** T1.x만으로 호출 수가 1~2로 떨어졌으므로 문서 규칙대로 S3는
  보류. 다만 §7.3의 남은 격차는 호출 *수*가 아니라 호출당 페이로드(22~25K자 ≈ 7K write 토큰 ≈ $0.03)
  이므로, 격차를 더 줄이려면 S3 또는 "첫 호출 파일 수 축소" 같은 페이로드 축소가 유일한 레버다 —
  iter2 실패(Read 폴백 증가) 위험을 감수할지는 유지보수자 판단.
- [ ] **T2.4** (S3 진행 시에만) 지도 모드 응답의 모든 안내 문구가 explore 재호출을 가리키는지 확인.

### Phase 3 — 방법론·문서

- [x] **T3.1 완료** 플레이북 §6 아래 "Repo-size × question-type cost matrix (CG-39)" 절 — §7.1·§7.2
  행 + T2.1 프로브 행, `window`(cold/warm) 열, 캐시 윈도우 주의 포함.
- [x] **T3.2 완료** CLAUDE.md "Validation methodology" 4번 통과 기준에 ≥25K 리포 간단 질문의
  `cache_creation + output` 비회귀 + explore 중앙값 ≤ 2 + 버킷으로 읽을 것 + 캐시 윈도우 주의 추가.
- [x] **T3.3 완료** CLAUDE.md 예산 표에 UnrealEngine 측정 행 추가, ~20K/~40K 행이 외삽임을 명시.
- [x] **T3.4** §7.2·7.3 기록, Status 갱신 (2026-09-03). 통제 리포 A/B와 cold 재측정이 끝나면 다시 갱신.

---

## 6. 측정 프로토콜

CLAUDE.md 규칙 그대로: `--model sonnet --effort high`, 팔당 **2회 이상**, CLI 차단 shim, 데몬 프리웜
(Unreal은 explore 1회 20초라 프리웜 없이는 에이전트가 codegraph 연결 전에 Read로 들어간다).

| 항목 | 값 |
|---|---|
| 대상 리포 | D:\UnrealEngine (≥25K 티어) |
| 통제 리포 | excalidraw (643 파일) 또는 vscode (10K) — flow 질문 비회귀용 |
| 질문 (개요) | "프로젝트에 구현된 카메라 시스템에 대해서 알려줘" · "입력 처리 시스템 개요" · "네트워크 리플리케이션은 어떻게 구성돼 있어" |
| 질문 (flow, 통제) | "PlayerController 입력이 CameraManager의 뷰 갱신까지 어떻게 도달해" |
| 팔 | with (codegraph MCP) / without (빈 MCP), 필요 시 new-build vs baseline (`ab-new-vs-baseline.sh`) |
| 기록 | 턴 수 · explore 호출 수 · 호출당 chars · Read · Grep · `cache_creation`(5m/1h) · `output` · `cache_read` · `total_cost_usd` · duration |

**캐시 윈도우 (§7.1에서 발견, 필수):** 같은 system+tools 프리픽스로 1시간 안에 다시 실행하면 두 번째
실행의 1턴째가 `write→read`로 바뀌어 싸게 나온다(TTL은 읽을 때마다 갱신). 따라서 각 팔의 **첫 실행은
직전 실행 후 1시간이 지난 뒤(cold)** 시작하고, 두 번째 실행은 의도적으로 warm으로 두어 cold↔cold,
warm↔warm 끼리만 비교한다. 표에 `window` 열로 기록.

**통과 기준**
1. 개요 질문: with 팔의 `cache_creation + output` 비용 ≤ without 팔 (동일 턴 수 범위에서), explore 호출 중앙값 ≤ 2.
2. flow 질문(Unreal): Read/Grep 증가 없음, flow 섹션 end-to-end 연결 유지.
3. 통제 리포 flow 질문: 기존 수치(excalidraw 0~2 Read, 3~4 codegraph) 비회귀.
4. 시간: with 팔이 without 팔보다 느려지지 않음.

---

## 7. 측정 결과

### 7.1 실행 1회차 (2026-09-02, D:\UnrealEngine, v1.5.0, 88,114 파일)

`claude -p --model sonnet --effort high --output-format stream-json --strict-mcp-config`로
동일 질문("프로젝트에 구현된 카메라 시스템에 대해서 알려줘")을 두 팔에 직접 실행. B 팔은
codegraph CLI를 PreToolUse hook으로 차단(`scripts/agent-eval/no-cli-shim.sh`와 동일한 정규식)해
Bash를 통한 오염을 막았다 — 최초 시도(hook 없음)는 B가 `codegraph explore`를 Bash로 3회 직접
호출해 폐기(`without-codegraph.CONTAMINATED.jsonl`으로 보존, $0.178, 오염값이라 표에서 제외).

| 팔 | 턴 | explore 호출 | chars/호출 | Read | Bash | write1h tok | read tok | output(보정) tok | cost | dur |
|---|---|---|---|---|---|---|---|---|---|---|
| A (with codegraph) | 4 | 3 | 25,504 / 25,515 / 16,214 | 0 | 0 | 50,679 | 140,898 | 3,735 | **$0.268** | 95.4s |
| B (without, clean) | 8 | — | — | 5 | 2 | 25,860 | 330,651 | 4,287 | **$0.212** | 97.3s |

**A가 B보다 26% 비쌈.** 턴 수·시간은 비슷(A 4턴/95s, B 8턴/97s)하다는 사용자 보고와 일치.

- **§3.1 확인:** A의 explore 3회 중 2회가 25K자 상한(`hardCeiling`)에 거의 닿았다(25,504·25,515자).
  세 번째만 16,214자로 작았다. `write1h` 토큰(50,679)이 A 비용의 76%를 차지 — 가설이 맞았다.
- **§3.2 확인:** A는 5회 예산 중 3회만 썼다(문구가 유도하는 상한까지 채우진 않음). 문구 완화(S1)의
  기대 효과는 "3→5"를 막는 것보다 "필요했던 것이 애초에 2회였는데 3회를 쓰게 만드는" 여유분을
  줄이는 쪽에 가까울 수 있다 — n=1이라 단정 불가, §6 프로토콜로 반복 필요.
- **§3.5 판정:** output(보정) 버킷은 A 3,735 tok vs B 4,287 tok로 오히려 **B가 근소하게 큼**.
  "A가 출력을 더 길게 쓴다"는 가설은 이 1회차에서는 기각. write1h 격차가 비용 차이의 거의 전부.
- **버그 발견 (측정 방법론):** `usage.output_tokens` 원시값은 신뢰 불가 — A·B 모두 턴당 2~4로
  찍혔지만 실제 답변 텍스트는 수백 자였다. `total_cost_usd`와 `write1h+read+input` 합계의 차이로
  역산해야 실제 output/thinking 비용이 나온다. `cost-breakdown.mjs`에 이미 반영, `parse-run.mjs`도
  같은 결함이 있을 수 있어 T0.2에서 함께 확인 필요.
- **새로 발견한 교란 요인 (측정 방법론, 중요):** 오염된 첫 B 실행과 재실행한 깨끗한 B 실행이
  **동일한 system+tools+첫 user 메시지 프리픽스**를 공유해, 두 번째 B 실행의 1턴째가
  `write1h=0 read=32,166`로 **완전 캐시 히트**했다 — 첫 실행이 이미 그 프리픽스를 캐시에 써둔 덕에
  두 번째 실행은 콜드 스타트 비용을 내지 않았다. A는 이런 선행 실행이 없어 순수 콜드 스타트값이다.
  즉 **이 표의 B는 실제보다 저렴하게 나왔을 가능성이 높고, 진짜 콜드-콜드 비교였다면 A/B 격차는
  26%보다 컸을 것**(방향은 가설과 일치, 크기는 과소 추정). 1시간 TTL 내에 동일 프리픽스로 반복
  실행하면 항상 이 현상이 생기므로, 다음 측정은 (a) 팔마다 최초 1회만 신뢰하거나 (b) 두 팔을 서로
  다른 1시간 캐시 윈도우에서 실행해야 한다. §6 프로토콜에 이 주의사항 추가 필요(T3.1에 반영).
- **결론:** n=1이지만 방향은 사용자 보고와 일치하고, 원인도 §3.1~3.2 가설대로 explore payload가
  write 버킷을 지배하는 것으로 확인됐다. 정확한 "최대 50%" 수치를 재현하려면 §6 프로토콜대로
  팔당 2회 이상, 캐시 윈도우를 분리해 반복해야 한다(Phase 0 T0.3 완료, 반복 실행은 미완료).

원본 로그·재현 자료: `docs/design/large-repo-simple-question-cost-logs/`
(`with-codegraph.jsonl` / `without-codegraph.jsonl` / `without-codegraph.CONTAMINATED.jsonl` +
재현용 `mcp-with.json` / `mcp-empty.json` / `hook-settings.json` / `no-cli-hook.sh` +
분석에 쓴 `cost-breakdown.mjs`).

> **주의:** 이 로그 폴더는 D:\UnrealEngine(Epic 소유, EULA로 재배포 제한)의 실제 소스 코드 조각을
> `tool_result` 안에 원문 그대로 포함한다. 로컬 커밋까지만 승인됐고 **origin/upstream에 푸시하지
> 않는다** — 공개 GitHub 포크이므로 push 전 반드시 사용자에게 재확인할 것.

### 7.2 실행 2회차 (2026-09-03, T1.1~T1.3 적용 빌드, 100,956 파일, 팔당 2회)

같은 질문, 같은 프로토콜(sonnet/high, CLI 차단 훅, 데몬 프리웜). 사용자 요청으로 캐시 윈도우 만료
(00:27) 전인 00:08에 시작해 **4회 모두 warm** — with 팔의 프리픽스도 캐시에 있었다(explore 툴 설명은
`ToolSearch`로 지연 로드되므로 system+tools 프리픽스에 들어가지 않는다; with-1의 1턴째 read 28,042 /
write 4,904). 따라서 이 표는 warm↔warm 비교이며 §7.1의 cold A와 직접 비교할 수 없다.

| 팔 | window | 턴 | explore | chars/호출 | Read | Grep/Glob | Bash | write1h tok | out(보정) tok | write+out | cost | dur |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with-1 | warm | 4 | **2** | 24,867 / 18,207 | 0 | 2 | 0 | 32,187 | 4,518 | $0.174 | **$0.203** | 89s |
| without-1 | warm | 9 | — | — | 0 | 1 | 8 (CLI 차단 1) | 14,164 | 4,622 | $0.103 | **$0.167** | 54s |
| with-2 | warm | 5 | **1** | 22,349 | 0 | 2 | 0 | 17,552 | 3,362 | $0.104 | **$0.142** | 71s |
| without-2 | warm | 8 | — | — | 4 | 1 | 5 (CLI 차단 1) | 3,065 | 3,688 | $0.049 | **$0.103** | 48s |

원본: `large-repo-simple-question-cost-logs/run2-ceiling-wording/` (4 jsonl + `compare.txt` +
`run.sh` — Windows 데몬 프리웜은 `sleep 900 | codegraph serve --mcp …` 로 stdin을 잡아둬야 뜬다,
`</dev/null`이면 클라이언트가 데몬을 띄우기 전에 종료됨).

### 7.3 2회차 판정

- **S1 효과 확인:** explore 호출 3 → 2 / 1 (중앙값 1.5, 기준 ≤2 통과). write 토큰 50,679 → 32,187 /
  17,552. explore 직후 행동 중 "explore again"은 3건 중 1건(CG-20의 52~57%에서 하락). 포인터 목록
  변경(T1.3)과 예산 문구 변경(T1.1/1.2)의 기여는 분리 측정하지 않음.
- **비용 기준 미달:** write+output은 with $0.104~0.174 vs without $0.049~0.103, 총액 $0.142~0.203 vs
  $0.103~0.167. with-2($0.104)는 without-1($0.103)과 같은 수준까지 내려왔지만 중앙값으로는 with가 여전히
  높다. 격차의 실체는 **explore 1회 페이로드(22~25K자 ≈ 7K write 토큰 ≈ $0.03) + 더 큰 상주 컨텍스트**
  (최종 컨텍스트 55K vs 40K 토큰).
- **시간 기준 미달:** with 71~89s vs without 48~54s. Unreal explore 1회 9~20초가 그대로 반영.
- **비대칭 주의:** without 팔은 답이 얕다 — without-2는 설정 파일·보일러플레이트 4개를 읽고 "AIProject에
  카메라 시스템 없음"으로 끝냈고, without-1은 소스를 한 파일도 열지 않고 디렉터리 목록으로 엔진 계층을
  서술했다. with 팔 2회는 모두 `APlayerCameraManager` 레거시 파이프라인과 GameplayCameras 플러그인을
  소스 기반으로 설명했다. 즉 "같은 답을 더 비싸게"가 아니라 "더 깊은 답을 explore 1회분만큼 더 비싸게"
  에 가깝다. 이 비대칭을 통제하려면 답 품질 채점(ground-truth 대조)이 필요하다.
- **§3.5(출력 토큰) 재확인:** output(보정)은 두 팔 모두 3.4~4.6K로 차이 없음. 기각 유지.
- **결론:** 문구 변경(S1/S4)은 유효하지만 ≥25K 리포 개요 질문의 비용 역전을 없애지는 못한다. 남은
  레버는 페이로드(S3 계열)뿐이며, T2.3 규칙대로 이번엔 착수하지 않는다. 통제 리포 비회귀 A/B는 미실행.
