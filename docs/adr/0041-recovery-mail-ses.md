# 0041 — Recovery mail qua SES (GoGo-BE#777)

Trạng thái: implementation viết xong, chờ Claude chạy gates và DEV acceptance.
Refs #777; cấu hình deploy phối hợp GoGo-Infra#339. Quyết định owner 2026-11-06,
issue text do owner cung cấp; không truy cập GitHub/AWS trong phiên này.

## Bối cảnh và lựa chọn

Recovery có sink cho DEV và adapter disabled. Owner chọn AWS SDK v3 SESv2;
Claude đã cài `@aws-sdk/client-sesv2` ^3.1162.0 vào `@gogo/modules` và lockfile.
Không dùng HTTP tự viết hoặc credential implementation riêng.

## Quyết định

`IdentityModule` chọn `ses` qua `AUTH_RECOVERY_MAIL_ADAPTER`; mặc định vẫn là
`disabled`. Không fallback về sink khi cấu hình SES thiếu. Sink chỉ dùng ở DEV.
`SdkRecoverySesClient` gọi `SESv2Client.send(new SendEmailCommand(input))`, dùng
region đã validate, connection timeout 1 giây, request timeout 3 giây với
`throwOnRequestTimeout=true`, `maxAttempts=1`. Không tự retry vì SES có thể đã
nhận mail trước khi timeout. Không giữ transaction DB trong lúc gửi.

Template text UTF-8 theo locale đã lưu của user: `en` dùng tiếng Anh, mọi giá
trị khác mặc định `vi`. Không thêm field vào public DTO/OpenAPI hoặc generated
client. Nội dung chỉ có mã sáu chữ số, expiry UTC và hướng dẫn bảo mật; không
có URL/token/challenge ID, provider tags, account ID hoặc lưu provider response.
Decoy `null` đi cùng adapter path nhưng không gọi SES.

Delivery chạy tách khỏi promise trả HTTP sau khi transaction đã commit; cả
eligible và decoy giữ cùng padding tối thiểu 250 ms, không chờ SES hoặc DB
invalidation. Provider chậm/timeout không kéo dài riêng response tài khoản thật.
Task xử lý lỗi gửi, invalidation và reporting nội bộ, không để rejected promise
thoát ra. Đây là task trong process, không phải durable queue: restart trong
lúc gửi có thể mất delivery/invalidation; client vẫn có thể resend sau cooldown.
Không thêm retry hoặc lưu raw code vào queue/database trong bản sửa này.

Mọi lỗi SendEmail (kể cả timeout/credential/provider outage) giữ response 202
và invalidate challenge theo digest + challenge ID để không vô hiệu challenge
mới do resend đồng thời. Không trả 503 riêng tài khoản thật. Invalidation là
best effort theo service hiện có: nếu DB cũng lỗi, proof còn hạn tối đa 300 giây;
không đổi contract theo tài khoản. Metric `password_recovery_failed{action=send}`
và error report cố định được ghi; SDK error/cause/payload không được đưa vào
report. Report qua observability boundary loại cả ambient request, user,
breadcrumb, tags và extra; chỉ giữ exception cố định, release/environment và
operation allowlist. Reporting lỗi không đổi response. Thành công ghi
`password_recovery_sent{adapter=ses}`; sink tiếp tục ghi `adapter=sink`.

Disabled/missing config bị từ chối trước account lookup; adapter thiếu config
trả 503 `RECOVERY_MAIL_NOT_CONFIGURED`, retryable false. API env validation
fail-fast nếu chọn SES mà thiếu hoặc sai cấu hình. Lỗi hạ tầng toàn cục trước
lookup (ví dụ shared quota) vẫn là 503 `RECOVERY_UNAVAILABLE`. Recovery quota
Redis phải fail closed; wrapper chỉ bỏ fallback local cho key `recovery|`,
giữ behavior của các key khác. Không có migration dữ liệu hoặc đổi API.

## Amendment 2026-11-10 — GoGo-BE#835, Refs #772

Owner (decisions-log): "Bỏ câu phụ tài khoản đủ điều kiện. Cứ báo tài khoản không tồn tại như các app khác thôi. Khi tài khoản đủ điều kiện thì chuyển màn input mã".

Quyết định mới thay phần anti-enumeration/luôn 202 ở trên cho request recovery.
Email không có tài khoản mật khẩu active (missing, passwordless, disabled,
deleted) trả cùng 404 `RECOVERY_ACCOUNT_NOT_FOUND`, retryable false, message
`Tài khoản không tồn tại`; không trả lý do cụ thể. Active password account vẫn
202 + challengeId; email chưa verify vẫn được recovery. Contract tăng MINOR
9.1.1-alpha.1 → 9.2.0-alpha.1 theo quyết định owner. Mobile#620 bỏ câu phụ
đủ điều kiện, ở lại màn email khi 404, chỉ sang màn mã khi 202.

Rủi ro được owner chấp nhận: HTTP 202/404 công khai khả năng recovery của email,
cho phép dò tập tài khoản có mật khẩu hoạt động. Padding không che được thông tin
này. Phương án giữ luôn 202 bị loại theo quyết định trên. Không phân biệt missing
với passwordless/disabled/deleted. Giữ 1/phút + 3/giờ/email, 10/phút + 50/giờ/IP
trước lookup/replay, kể cả request 404 và retry cùng key; quota Redis fail closed.
Giữ decoy challenge/replay trong DB với HMAC và cùng retention/cooldown 60 giây,
code ngẫu nhiên, công việc send/discard và padding tối thiểu 250 ms. Throw 404
sau commit decoy; không rollback cooldown, không gửi mail cho ineligible.

Eligible idempotency giữ thứ tự quota → cooldown → replay/body-conflict. Replay
đã lưu chỉ trả 202 khi account hiện vẫn eligible; account chuyển ineligible
nhận cùng 404 sau cooldown. Đổi body cùng key vẫn 422. Không thêm retry delivery,
không đổi complete, không đổi reset/session revocation hoặc DB schema.
Counter `password_recovery_not_found` không có nhãn; không log email/lý do
ineligible, không tính not_found vào generic failure. SES failure vẫn 202 cho
eligible; global config/persistence/quota failures giữ 503 như trước.

Rollout cùng Mobile#620 sau khi đồng bộ generated contract; xác minh các nhánh
404/202/429 trên DEV. Rollback service về hành vi luôn 202 cần đồng bộ Mobile
và công bố contract tương ứng; không cần rollback dữ liệu/migration. Tắt mail
vẫn dùng adapter disabled và trả 503 như phần vận hành bên dưới.

## Required configuration

Mapping phối hợp cho **GoGo-Infra#339** dưới đây là tên BE yêu cầu. Infra cần
provision và inject đúng tên; phiên này không xác minh provisioning/manifest.
`<env>` là deployment environment, cùng path shape ở DEV/staging/production.
Không lưu giá trị sender, credential hoặc token thật trong repo.

| SSM name                                                       | API env                                | Type                                           |
| -------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `/gogo/<env>/backend/auth/recovery-mail-adapter`               | `AUTH_RECOVERY_MAIL_ADAPTER`           | String (`ses` khi bật; default `disabled`)     |
| `/gogo/<env>/backend/auth/recovery-mail-sender`                | `AUTH_RECOVERY_MAIL_SENDER`            | String (mailbox verified trong SES)            |
| `/gogo/<env>/backend/auth/recovery-mail-region`                | `AUTH_RECOVERY_MAIL_REGION`            | String (region của identity/configuration set) |
| `/gogo/<env>/backend/auth/recovery-mail-configuration-set`     | `AUTH_RECOVERY_MAIL_CONFIGURATION_SET` | String                                         |
| `/gogo/<env>/backend/auth/recovery-key`                        | `AUTH_RECOVERY_KEY`                    | SecureString (ít nhất 32 ký tự)                |
| `/gogo/<env>/backend/auth/recovery-mail-aws-access-key-id`     | `AWS_ACCESS_KEY_ID`                    | SecureString                                   |
| `/gogo/<env>/backend/auth/recovery-mail-aws-secret-access-key` | `AWS_SECRET_ACCESS_KEY`                | SecureString                                   |

Owner quyết định cùng **một cơ chế credential ở mọi environment**: một IAM user
riêng cho từng environment, chỉ có quyền `ses:SendEmail`, giới hạn verified
sender identity và region/resource phù hợp. Access key pair nằm trong SSM
SecureString như bảng, deploy inject vào API env giống các secret khác. BE chỉ
để SDK default credential chain đọc standard AWS env vars; không truyền
`credentials`, không đọc SSM trực tiếp, không có nhánh instance-role/DEV riêng.
API validation yêu cầu cả hai env credential khi chọn SES, kể cả workstation.
API từ chối giá trị nonempty (kể cả whitespace) của `AWS_PROFILE`,
`AWS_SESSION_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`, `AWS_CONFIG_FILE`,
`AWS_SHARED_CREDENTIALS_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`,
`AWS_ROLE_SESSION_NAME`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`,
`AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN` và
`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` khi chọn SES. Chặn nguồn credential
khác, nhất là SDK ưu tiên profile hơn env key pair; không thay default chain.
Disabled/sink không áp giới hạn này. Tên SSM trong bảng giữ nguyên.

Infra cần verified identity, configuration set trong cùng region, event
configuration không ghi body/PII, sandbox recipient hợp lệ ở DEV (hoặc SES đã
thoát sandbox), và Redis shared quotas. Worker không cần SES key. Deploy phải
inject raw credential env vào process; object config đã parse không phải
credential source của SDK. Các SES field và credential chỉ required khi chọn
`ses`; env catalogue đánh dấu chúng conditionally required.

## Kiểm chứng, rollout và rollback

Đã bổ sung unit cases: SDK command/options, selection SES/disabled/sink,
conditional env validation, template vi/en/default, decoy, sanitized provider
error, locale pass-through, SES metric, 202 + invalidation khi lỗi gửi,
shared quota fail-closed và report không mang ambient PII. Bản sửa Astra r1
thêm regression delivery 750 ms, timeout 3 giây, invalidation chậm/lỗi,
late failure không invalidate resend mới, và từ chối nguồn AWS credential khác.
Sol chỉ chạy regression/unit liên quan; Claude vẫn chạy full gates và commits.

Claude chạy mọi gate, gồm observability/Sentry boundary và regression HTTP
anti-enumeration trên cùng revision. Infra#339 provision/inject mapping trên;
owner bật SES trên DEV rồi kiểm tra tài khoản test nhận code và reset được.
Kiểm tra missing/ineligible accounts vẫn cùng contract; SES failure vẫn 202,
challenge bị invalidate, telemetry/report không có PII; Redis outage từ chối
trước lookup. Chưa có DEV acceptance hoặc xác nhận Infra#339 khớp mapping.

Rollback đặt `AUTH_RECOVERY_MAIL_ADAPTER=disabled`, redeploy; request trả
`RECOVERY_MAIL_NOT_CONFIGURED`. Không cần rollback migration. Khi rotate IAM
key: cập nhật SSM, redeploy API, xác minh gửi trước khi revoke key cũ; tách key
mỗi environment để không ảnh hưởng các môi trường khác.
