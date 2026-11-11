# ADR-0053: Dữ kiện credit cá nhân — GoGo-BE#832, chỉ slice V

Ngày: 2026-11-10. Trạng thái: triển khai theo SA shape
`dev/handoffs/sa-shape-be-832-credit-spend.astra.md` §1 V, §6 V, §7 V,
§10 rollout V và §11 V1–V3. Chưa có bằng chứng integration/DEV acceptance.

Người dùng cần số dư và lịch sử của chính mình trước khi nền tảng cấp thưởng
S2–S4 hoặc tính phí thực tế sẵn sàng. Dùng lại `assistant_credit_accounts` và
`assistant_credit_ledger`; không tạo ví mới hoặc migration. Không sửa quy tắc
daily-first / một credit mỗi accepted send của ADR-0040. Không triển khai D
(chi phí USD, hold, settlement/reconciliation writer) hoặc W (welcome).

`GET /v1/me/credits` trả posted balance, lifetime earned/spent, reserved=0,
availableBalance=balance, asOf và open policyKey=`legacy_allowance_v1`.
Mỗi response summary dùng một SQL snapshot cho user đang active, account và
tổng ledger. Earned là grants; spent là số trừ usage ròng sau refund. Refund
`assistant_usage_adjustment` giảm spent, không tăng earned. Reader hiểu mã này
để tương thích; V không thêm writer/constraint cho refund. GET không sửa lệch
sổ cái: phát counter `assistant_credit_account_mismatch_total` không có nhãn
định danh/số dư. Account thiếu trả zero, không insert.

`GET /v1/me/credits/ledger` lấy 11 và trả tối đa 10 dòng theo
`(created_at DESC,id DESC)`, strict `<`. `limit` vắng hoặc 10; giá trị khác bị
từ chối. Cursor base64url version 1 chứa subject, UTC đủ sáu chữ số và UUID;
validate encoding, shape, version, timestamp và subject. Đây không phải
credential/chữ ký: sửa cursor không đổi phạm vi actor trong SQL. Cursor sai
hoặc khác user trả `400 INVALID_CURSOR`. Refresh bỏ cursor để thấy dòng mới;
không cam kết snapshot xuyên request. Query history không nhận user ID.

Public projection chỉ có id, createdAt, delta, open direction/eventKey/source,
và optional catalogue eventId khi cột S2 có mặt. `to_jsonb(ledger)` đọc cột
optional mà không phụ thuộc migration S2. Reason catalogue là eventKey; không
join entitlements hoặc nhân đôi historical +70. Không trả venue, submission,
entitlement key/HMAC, usage ID, provider bill hoặc text. Message links/captions
là tùy chọn theo shape và chưa được thêm trong V này. Không suy đoán zero
cho lịch sử tin nhắn thiếu attribution. Không thay đổi closed CMS reason enum.

Hai route yêu cầu session hợp lệ và registered actor; guest/admin nhận
`403 USER_ONLY`; user thiếu/suspended/banned/deleted nhận 401 khi display bật.
Rate limit riêng 60/phút/actor. Hook chạy trước guards/validation đặt
`Cache-Control: private, no-store` cho cả thành công và lỗi.

Contract additive MINOR từ `9.4.0-alpha.1` thành `9.5.0-alpha.1`; sinh types bằng
`pnpm api:types`, kiểm version bằng tooling repo với bản spec trước sửa lưu
ngoài worktree (không chạy git). `GET /me` thêm optional capability
`capabilities.assistantCredits`; vắng hoặc false nghĩa là client không mở CTA.
BE resolve và kiểm tra lại flag `assistant_credits.display_enabled` mặc định
false trên từng request, độc lập `credit_events.enabled` và charging. Flag tắt
trả `404 CREDITS_DISPLAY_DISABLED`; capability chỉ true cho active account.

Rollout V: phát hành BE + contract/types, đồng bộ generated client Mobile,
chỉ cho client biết capability 9.5+ mở UI; kiểm chứng trên DEV rồi bật display
cho môi trường dự định qua feature-flag API/CMS hiện có. V chưa nghiệm thu
cost charging #832 hoặc welcome. Không đổi evaluator/cutover. Rollback display
flag riêng; giữ ledger/account và quy tắc AI đang chạy. Không có D/W flag.

Specs: `apps/api/test/me-credits.int.spec.ts` ánh xạ V1–V3: self/auth/guest,
inactive, flag/capability/no-store, no-account/no-write, 0/10/11/21 rows,
microsecond/UUID ties, subject cursor, grant xen trang, mixed 20/50/70/-1,
nguồn/usage không còn, public facts, và isolated compatibility fixture cho
catalogue key/component entitlements/refund. Fixture chỉ shadow table trong
transaction rollback, không nới constraint production hoặc thêm D migration.
Integration chưa chạy theo giới hạn owner. Unit specs kiểm cursor, fixed page,
open facts, scoping, flag, totals overflow và mismatch telemetry.
