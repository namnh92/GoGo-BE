# GoGo-BE#883 — bằng chứng guard phát hiện rò rỉ giá

## PR #884 — sửa review round 1

Refs #883. Ngày chạy: 2026-11-12. Vai trò Sol; owner yêu cầu sửa và chạy gate.
Worktree bắt đầu sạch tại `9ea70072a4f4e3261d7cb39eb2f8faefe2a60b6c`
(`bugfix/GOGO-883-price-leak-guards`). Kết quả sau sửa áp dụng cho diff chưa commit
trên HEAD này. Không commit; không sửa product code hoặc S3 Layer A.

### F-01 P1 — dependency ngược từ libs vào apps

Nguyên nhân: ba unit spec của assistant import `minorUnitAmounts` và
`stripVolatile` từ `apps/api/test/support`, tạo sáu dependency vi phạm hướng
`libs → apps`. Không thay đổi checker hoặc bỏ qua spec.

Sửa: chuyển cả hai helper cùng hai spec sang
`libs/modules/shared/test-support/` (thuộc `shared` trong tsconfig của modules).
Ba unit spec import trong libs; integration spec tại
`apps/api/test/assistant-place-answer.int.spec.ts` import vào libs.
`stripVolatile` và spec của nó giữ nguyên byte; các assertion của bốn consumer
không đổi.

| Bằng chứng                               | Lệnh                    | Exit | Kết quả                                                    |
| ---------------------------------------- | ----------------------- | ---- | ---------------------------------------------------------- |
| FAIL trước sửa, worktree sạch `9ea70072` | `pnpm check:boundaries` | 1    | 823 file, 6 violation tại hai import đầu của mỗi unit spec |
| PASS sau sửa                             | `pnpm check:boundaries` | 0    | 827 file, không còn violation                              |

### F-02 P2 — regex match một phần số tiền khác

Nguyên nhân: alternation không có ranh giới, nên `12000` match trong `120000`
hoặc `112000`, và `12\.000` match trong `12.0000` hoặc `12.000.000`.

Sửa: đặt `(?<!\d)(?<!\d[.,])` trước toàn bộ alternation và
`(?!\d|[.,]\d)` sau nó. Mọi alternative raw/vi/en chịu cùng ranh giới:
không có chữ số sát cạnh, không tiếp tục một số qua dấu chấm hoặc dấu phẩy.
Dấu câu thông thường vẫn hợp lệ, ví dụ `Price:(12.000), per person.`.
Không dùng word boundary vì giá có thể sát chữ hoặc ký hiệu tiền tệ.

Thêm 42 negative cells cho 0, 123, 12000, 24000 và 1234567, gồm chữ số trước/sau,
số raw/grouped lớn hơn, nhóm phân cách nối tiếp hoặc trộn dấu. Mỗi cell kiểm tra
text, JSON và SSE frame. Giữ các positive cells raw/vi/en và volatile metadata;
thêm positive text, JSON number/string và SSE cho cả 12000/24000.

| Bằng chứng                                                       | Lệnh                                                                                   | Exit | Kết quả                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| FAIL trên helper nguyên bản `9ea70072`, chỉ thêm regression spec | `pnpm exec vitest run --project unit apps/api/test/support/minor-unit-amounts.spec.ts` | 1    | 42 negative cells FAIL, 21 test khác PASS; lỗi assertion `.not.toMatch`, không phải setup/import |
| PASS sau sửa và chuyển helper                                    | `pnpm exec vitest run --project unit <5 spec bên dưới>`                                | 0    | 5 file, 254 test PASS; riêng matcher 63/63                                                       |

Log trước sửa: `/tmp/gogo-884-r1-boundaries-before.log`,
`/tmp/gogo-884-r1-amounts-before.log`. Regression spec trước sửa chính là spec
hiện tại ở `libs/modules/shared/test-support/minor-unit-amounts.spec.ts`, chạy
khi còn ở đường dẫn app, với helper và `stripVolatile` nguyên bản từ HEAD.

### Gate sau sửa

| Lệnh                                                                                                                                     | Exit | Kết quả                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `pnpm check:boundaries`                                                                                                                  | 0    | 827 file, không có violation                                                                           |
| `pnpm typecheck`                                                                                                                         | 0    | 8/8 package tasks PASS; Turbo cảnh báo không ghi được shared cache do sandbox, không có lỗi TypeScript |
| `pnpm exec eslint <8 file TS>`                                                                                                           | 0    | PASS                                                                                                   |
| `pnpm exec prettier --check <8 file TS> docs/plans/883-validation.md`                                                                    | 0    | PASS                                                                                                   |
| `pnpm exec vitest run --project unit <5 spec>`                                                                                           | 0    | 5 file, 254 test PASS                                                                                  |
| `pnpm test` (full unit)                                                                                                                  | 1    | 345 file PASS, 2 file FAIL; 5082 test PASS, 1 FAIL, 1 skipped                                          |
| `pnpm exec vitest run --project unit --maxWorkers=1 apps/api/src/sentry-request.spec.ts libs/modules/assistant/domain/grounding.spec.ts` | 1    | Grounding: 38/38 PASS; Sentry: lỗi suite trước test do `listen EPERM`, 1 skipped                       |
| `git diff --check`                                                                                                                       | 0    | PASS                                                                                                   |

Full unit chưa xanh: `apps/api/src/sentry-request.spec.ts` không bind được
`127.0.0.1` trong sandbox (`listen EPERM`). Test
`S2-F-03: a long chain of overlapping names stays cheap and leaks nothing` tại
`libs/modules/assistant/domain/grounding.spec.ts:315` mất 1532 ms, vượt ngưỡng
1000 ms khi full unit chạy cùng typecheck/eslint/focused. Lần chạy cô lập, một
worker và không còn gate khác, toàn bộ 38 grounding test PASS; lỗi bind của
Sentry vẫn tái hiện. Không sửa hoặc skip test để làm gate xanh.
`git diff --exit-code 9ea70072 -- apps/api/src/sentry-request.spec.ts libs/modules/assistant/domain/grounding.spec.ts libs/modules/assistant/domain/grounding.ts`
exit 0: các file này không đổi; không import helper đang sửa.

Log sau sửa: `/tmp/gogo-884-r1-{boundaries,typecheck,eslint,focused,unit}-after.log`,
`/tmp/gogo-884-r1-unit-isolated.log`, `/tmp/gogo-884-r1-prettier-after.log`.

Lệnh tái chạy trên diff hiện tại (8 file TS được chạm):

```sh
pnpm check:boundaries
pnpm typecheck
pnpm exec eslint libs/modules/shared/test-support/minor-unit-amounts.ts libs/modules/shared/test-support/minor-unit-amounts.spec.ts libs/modules/shared/test-support/strip-volatile.ts libs/modules/shared/test-support/strip-volatile.spec.ts apps/api/test/assistant-place-answer.int.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts
pnpm exec prettier --check libs/modules/shared/test-support/minor-unit-amounts.ts libs/modules/shared/test-support/minor-unit-amounts.spec.ts libs/modules/shared/test-support/strip-volatile.ts libs/modules/shared/test-support/strip-volatile.spec.ts apps/api/test/assistant-place-answer.int.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts docs/plans/883-validation.md
pnpm exec vitest run --project unit libs/modules/shared/test-support/minor-unit-amounts.spec.ts libs/modules/shared/test-support/strip-volatile.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts
pnpm test
git diff --check
```

Đã so sánh byte cả 9 file trong `overlay` của
`scripts/eval/place-qa-layer-a-base.sh` với `git show 9ea70072:<path>`:
9/9 không đổi. Không chạy integration hoặc Layer A; yêu cầu round này là
focused và full unit. Các log `/tmp` là artifact cục bộ của phiên này.

## Bằng chứng trước round 1 (lịch sử tại `9ea70072`)

Các phần dưới ghi run tạo commit `9ea70072` từ base `13701a66`.
Đường dẫn app, substring matching, số test và hash trong phần lịch sử là trạng
thái trước hai fix trên; lệnh hiện tại dùng phần round 1. Runner lịch sử cần
đổi hai helper import sang `../../../../libs/modules/shared/test-support/`
khi chạy probe trong `apps/api/test/support` trên diff hiện tại.

Refs #883, #877. Ngày chạy: 2026-11-12. Vai trò: Sol, chỉ sửa test.
Branch `bugfix/GOGO-883-price-leak-guards`, HEAD/base `13701a66`.
Không commit. Không sửa product code, OpenAPI hay file overlay Layer A.

## Thay đổi và danh sách guard

`minorUnitAmounts(12000, 24000)` bắt `12000`, `12.000`, `12,000`,
`24000`, `24.000`, `24,000`. Dấu chấm được escape; hỗ trợ nhiều nhóm nghìn,
không chấp nhận trộn dấu phân cách. Giữ substring matching như guard cũ;
mọi guard số tiền đã sửa đều gọi `stripVolatile` trước khi so khớp.
Các assertion tên, địa chỉ, delimiter, ngày, VND và hành vi khác được giữ.

| ID  | Guard đã sửa (file:line)                                             | Dữ liệu được kiểm tra / điểm tiêm lỗi                               |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| I1  | `apps/api/test/assistant-place-answer.int.spec.ts:168`               | JSON persisted rows; thêm giá vào text trước serialize              |
| I2  | `apps/api/test/assistant-place-answer.int.spec.ts:172`               | Frame buffer; thêm delta frame chứa giá                             |
| I3  | `apps/api/test/assistant-place-answer.int.spec.ts:206`               | History sau thay đổi facts; thêm delta chứa giá trong snapshot body |
| I4  | `apps/api/test/assistant-place-answer.int.spec.ts:246`               | CMS khi facts lỗi; thêm giá vào text trong snapshot body            |
| I5  | `apps/api/test/assistant-place-answer.int.spec.ts:273`               | Persisted export; thêm giá vào message text                         |
| U1  | `libs/modules/assistant/application/place-answer-reader.spec.ts:119` | `fixtureRow.text` sau reader; thêm giá vào row gốc                  |
| U2  | `libs/modules/assistant/application/place-qa.service.spec.ts:153`    | Producer state/trace/frames; thêm giá vào state.text và delta frame |
| U3  | `libs/modules/assistant/application/place-qa.service.spec.ts:650`    | Confirm response; thêm giá vào named.view.text                      |
| U4  | `libs/modules/assistant/application/place-qa.service.spec.ts:689`    | Candidate unavailable; thêm giá vào closed.view.text                |
| U5  | `libs/modules/assistant/domain/place-qa/templates.spec.ts:57`        | Giá không đủ điều kiện; thêm giá vào a.text                         |
| U6  | `libs/modules/assistant/domain/place-qa/templates.spec.ts:95`        | Không có giá đủ điều kiện, vi/en; thêm giá vào a.text               |
| U7  | `libs/modules/assistant/domain/place-qa/templates.spec.ts:197`       | Địa điểm unavailable; thêm giá vào a.text                           |

Layer-A-reported, **không sửa**: `apps/api/test/assistant-place-qa-s3.int.spec.ts:318–320`
(regex ở dòng 319: `/Quán Sao Lạ|12000|12 Đường Hư Cấu/`). Chưa bắt giá có dấu
phân cách, chưa qua `stripVolatile`; chờ SA quyết định #874.
Đã đối chiếu cả 9 file trong `overlay` của `scripts/eval/place-qa-layer-a-base.sh`:
tất cả byte-identical với HEAD.

Rà `apps/api/test/*.int.spec.ts` và toàn bộ unit spec dưới
`libs/modules/assistant`: ngoài danh sách trên không thấy guard literal số tiền
có nhóm nghìn khác cần sửa. Guard `123` / `123 VND` giữ nguyên vì cả ba dạng
với số dưới 1000 giống nhau; kiểm tra rating/ngày/điện thoại không phải số tiền.
`assistant.live.int.spec.ts:141` đã dùng `[.,]` cho giá có dấu phân cách.
`strip-volatile.spec.ts` kiểm tra riêng chuỗi raw của fixture, không phải guard
vắng mặt giá trong kết quả place-answer.

## Kết quả kiểm tra

| Lệnh                                                                           | Exit | Kết quả                                                        |
| ------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------- |
| `pnpm typecheck`                                                               | 0    | 8/8 package tasks thành công                                   |
| `pnpm exec eslint <6 file TS bên dưới>`                                        | 0    | PASS                                                           |
| `pnpm exec prettier --check <6 file TS bên dưới> docs/plans/883-validation.md` | 0    | PASS                                                           |
| `pnpm exec vitest run --project unit <5 spec bên dưới>`                        | 0    | 5 files, 210 tests PASS; chạy lại sau hoàn nguyên              |
| `python3 /tmp/gogo-883-can-fail.py`                                            | 0    | Runner kiểm tra đủ FAIL mong đợi rồi hoàn nguyên byte-for-byte |
| `git diff --check`                                                             | 0    | PASS                                                           |

Các lệnh gate đầy đủ:

```sh
pnpm typecheck
pnpm exec eslint apps/api/test/support/minor-unit-amounts.ts apps/api/test/support/minor-unit-amounts.spec.ts apps/api/test/assistant-place-answer.int.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts
pnpm exec prettier --check apps/api/test/support/minor-unit-amounts.ts apps/api/test/support/minor-unit-amounts.spec.ts apps/api/test/assistant-place-answer.int.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts docs/plans/883-validation.md
pnpm exec vitest run --project unit apps/api/test/support/minor-unit-amounts.spec.ts apps/api/test/support/strip-volatile.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts
git diff --check
```

## Can-fail và PASS sau hoàn nguyên

**Phạm vi bằng chứng:** U1–U7 chạy trong chính các unit test đã sửa, với mutation
tạm ngay trước assertion số tiền. I1–I5 chạy dưới project unit bằng cách sao chép
nguyên văn năm assertion từ integration spec vào probe tạm và dùng snapshot
text/frames/export tương ứng. Probe dùng `fixtureRow` thật cho reference rows.
Đây là bằng chứng assertion có thể FAIL; **không phải** bằng chứng DB/API/Redis
integration. DEV chạy integration theo phân công của task; Sol không chạy integration.

Mỗi guard được tiêm riêng từng dạng `12.000`, `12,000`, `24.000`, `24,000`.
U6 chạy cả vi/en, nên 12 guard sites tương ứng 13 test cases.
Không đổi matcher hay sửa code sản phẩm để tạo lỗi.

| Mutation                  | Exit Vitest | FAIL mong đợi                  | PASS còn lại | Hoàn nguyên |
| ------------------------- | ----------- | ------------------------------ | ------------ | ----------- |
| `12.000`                  | 1           | 13/13: I1–I5, U1–U7 (U6 vi/en) | 176          | Sau cùng    |
| `12,000`                  | 1           | 13/13: I1–I5, U1–U7 (U6 vi/en) | 176          | Sau cùng    |
| `24.000`                  | 1           | 13/13: I1–I5, U1–U7 (U6 vi/en) | 176          | Sau cùng    |
| `24,000`                  | 1           | 13/13: I1–I5, U1–U7 (U6 vi/en) | 176          | Sau cùng    |
| Không tiêm giá (reverted) | 0           | 0                              | 189          | Đã xác nhận |

Cả 52 lỗi đều là `AssertionError: expected ... not to match /(?:12000|12\.000|12,000|24000|24\.000.../`.
Không có lỗi setup/import hay assertion khác che guard. Ví dụ U2:
`expected '["...a1::vi:price...12.000",{"route":...` not to match amount pattern.
Sau run PASS, runner phục hồi byte-for-byte ba unit spec và xoá probe tạm
`apps/api/test/support/883-guard-probes.spec.ts`. Không còn mutation trong diff.

Lệnh thực tế từng run (stdout/stderr cùng tên `.log`, JSON chứa từng test result):

```sh
pnpm exec vitest run --project unit libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts apps/api/test/support/883-guard-probes.spec.ts --reporter=json --outputFile=/tmp/gogo-883-can-fail/12dot000.json # exit 1
pnpm exec vitest run --project unit libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts apps/api/test/support/883-guard-probes.spec.ts --reporter=json --outputFile=/tmp/gogo-883-can-fail/12comma000.json # exit 1
pnpm exec vitest run --project unit libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts apps/api/test/support/883-guard-probes.spec.ts --reporter=json --outputFile=/tmp/gogo-883-can-fail/24dot000.json # exit 1
pnpm exec vitest run --project unit libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts apps/api/test/support/883-guard-probes.spec.ts --reporter=json --outputFile=/tmp/gogo-883-can-fail/24comma000.json # exit 1
pnpm exec vitest run --project unit libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts apps/api/test/support/883-guard-probes.spec.ts --reporter=json --outputFile=/tmp/gogo-883-can-fail/reverted.json # exit 0
```

Log gate cục bộ: `/tmp/gogo-883-typecheck.log`, `/tmp/gogo-883-eslint.log`,
`/tmp/gogo-883-unit-final.log`, `/tmp/gogo-883-prettier.log`.
Tóm tắt can-fail: `/tmp/gogo-883-can-fail/summary.json` (`restored: true`).
Các đường dẫn `/tmp` là artifact của phiên này; runner dưới đây cho phép tái tạo.

## Runner tái tạo can-fail

Lưu nội dung sau thành `/tmp/gogo-883-can-fail.py`, chạy từ root worktree:
`python3 /tmp/gogo-883-can-fail.py` (exit 0). Runner dùng `finally` để hoàn nguyên
kể cả khi số FAIL khác dự kiến. Không chạy đồng thời gate khác khi mutation đang tồn tại.

```python
from pathlib import Path
import hashlib, json, re, subprocess

root = Path.cwd()
evidence = Path('/tmp/gogo-883-can-fail')
evidence.mkdir(exist_ok=True)
integration = root / 'apps/api/test/assistant-place-answer.int.spec.ts'
units = [root / p for p in [
    'libs/modules/assistant/application/place-answer-reader.spec.ts',
    'libs/modules/assistant/application/place-qa.service.spec.ts',
    'libs/modules/assistant/domain/place-qa/templates.spec.ts',
]]
probe = root / 'apps/api/test/support/883-guard-probes.spec.ts'
assert not probe.exists()
originals = {p: p.read_bytes() for p in units}
# Copy the five actual integration assertions, not a replacement matcher.
assertions = [m.group().strip() for m in re.finditer(
    r'^\s*expect\(stripVolatile[\s\S]*?;(?=\n)', integration.read_text(), re.M
) if 'minorUnitAmounts(' in m.group()]
assert len(assertions) == 5
prefix = """import { it, expect } from 'vitest';
import { minorUnitAmounts } from './minor-unit-amounts';
import { stripVolatile } from './strip-volatile';
import { fixtureRow } from '../../../../libs/modules/assistant/domain/place-qa/fixtures';
"""
builders = [
    "const persisted = { rows: [{ ...fixtureRow(), frames: [{ type: 'delta', text: '' }] }] }; persisted.rows[0].text += leak; const raw = JSON.stringify(persisted.rows);",
    "const s = { messageId: 'm' }; const frames = [{ type: 'delta', text: fixtureRow().text }]; frames.push({ type: 'delta', text: leak }); const buffer = { read: async () => frames };",
    "const persisted = { items: [{ text: 'Unavailable place', frames: [{ type: 'delta', text: leak }] }] }; const changed = { body: JSON.stringify(persisted) };",
    "const persisted = { items: [{ text: 'GoGo could not load place data. Please try again.' + leak }] }; const cms = { body: JSON.stringify(persisted) };",
    "const exported = [{ messages: [{ text: 'GoGo place' + leak }] }];",
]
records = []
def run(label, files):
    command = ['pnpm', 'exec', 'vitest', 'run', '--project', 'unit', *files,
               '--reporter=json', '--outputFile=' + str(evidence / (label + '.json'))]
    with (evidence / (label + '.log')).open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    report = json.loads((evidence / (label + '.json')).read_text())
    record = {'label': label, 'command': command, 'exit': result.returncode,
              'passed': report['numPassedTests'], 'failed': report['numFailedTests']}
    records.append(record)
    print(json.dumps(record), flush=True)
    return record
try:
    for form in ['12.000', '12,000', '24.000', '24,000', '']:
        label = form.replace('.', 'dot').replace(',', 'comma') or 'reverted'
        for p, original in originals.items():
            text = original.decode()
            if form:
                # Mutate immediately before each actual amount guard. This keeps
                # earlier equality/name assertions from masking a weak guard.
                def inject(match):
                    assertion = match.group()
                    if 'minorUnitAmounts(' not in assertion:
                        return assertion
                    if 'JSON.stringify(row)' in assertion:
                        mutation = f'row.text += {json.dumps(form)};'
                    elif 'f.state.text' in assertion:
                        mutation = f"f.state.text += {json.dumps(form)}; f.frames.push({{ type: 'delta', text: {json.dumps(form)} }});"
                    elif 'named.view.text' in assertion:
                        mutation = f'named.view.text += {json.dumps(form)};'
                    elif 'closed.view.text' in assertion:
                        mutation = f'closed.view.text += {json.dumps(form)};'
                    else:
                        assert 'a.text' in assertion
                        mutation = f'a.text += {json.dumps(form)};'
                    return '\n' + mutation + assertion
                text = re.sub(r'^\s*expect\(stripVolatile[\s\S]*?;(?=\n)', inject, text, flags=re.M)
            p.write_text(text)
        # Unit probes of integration assertions: persisted-shaped fixtures only,
        # no Postgres, Redis, Testcontainers or API execution.
        probe.write_text(prefix + '\n'.join(
            f"it('I{i+1}', async () => {{ const leak = {json.dumps(form)}; {setup}\n{assertion}\n}});"
            for i, (setup, assertion) in enumerate(zip(builders, assertions))
        ))
        record = run(label, [str(p.relative_to(root)) for p in units] + [str(probe.relative_to(root))])
        expected = 13 if form else 0  # 7 unit guard sites -> 8 cases, plus 5 probes
        assert record['exit'] == (1 if form else 0), record
        assert record['failed'] == expected, record
finally:
    for p, original in originals.items():
        p.write_bytes(original)
    probe.unlink(missing_ok=True)
    restored = all(p.read_bytes() == original for p, original in originals.items())
    (evidence / 'summary.json').write_text(json.dumps({'runs': records, 'restored': restored}, indent=2))
    assert restored
```

## Còn lại cho DEV

Integration **NOT RUN** trong vai trò Sol. Chạy trên diff đã hoàn nguyên:

```sh
pnpm exec vitest run --project integration --no-file-parallelism apps/api/test/assistant-place-answer.int.spec.ts
```

DEV bổ sung kết quả tích hợp thật; nếu cần chứng minh xuyên DB/API, tiêm lần lượt
các giá có dấu phân cách vào persisted row/frame buffer trước từng guard I1–I5,
chạy test tương ứng FAIL rồi hoàn nguyên và chạy PASS. Kết quả unit probe ở trên
không thay thế bằng chứng xuyên DB/API đó. Layer A giữ nguyên chờ #874.

## Định danh nội dung đã kiểm tra

SHA-256 sáu file TS sau hoàn nguyên (doc này ghi kết quả, không tự hash):

```text
1e4f822fb2021a2cc180a201a4e22da6e4f90e73cb78521f61ef45ebde04427d  apps/api/test/support/minor-unit-amounts.ts
738f338bba42328721541121e64b8ced2e942635f333f0f30970d4f02e60b584  apps/api/test/support/minor-unit-amounts.spec.ts
f3e9a395b35bc3dc4f675b5b9da25e91a6d007779ad3ce0e65a7f7c875beec1c  apps/api/test/assistant-place-answer.int.spec.ts
d423f30c8f266c78b8944af5a26aaddf2cb1368fc2dd382161839de05e0e7007  libs/modules/assistant/application/place-answer-reader.spec.ts
dd0601e3c11213eabf357a6cfff199da08de2e01feec847afdea86bb63f0157e  libs/modules/assistant/application/place-qa.service.spec.ts
b5a90ed9aca719bac567878fc77a4a70ae57648a5e5e71fdc5169c65fc7fc495  libs/modules/assistant/domain/place-qa/templates.spec.ts
```
