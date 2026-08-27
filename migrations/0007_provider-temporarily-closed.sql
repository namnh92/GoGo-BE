-- BE-IMP-004 (a): "tạm đóng cửa" là một dữ kiện của provider, không phải một
-- quyết định kiểm duyệt.
--
-- Trước đây CLOSED_TEMPORARILY bị map thành 'unknown', tức trộn "quán đang tạm
-- nghỉ" với "không biết tình trạng". Và dùng places.status = 'suspended' cho
-- việc này còn tệ hơn: sau đó không phân biệt được place bị gỡ vì vi phạm với
-- place chỉ đang nghỉ Tết. places.status giữ nguyên nghĩa moderation/workflow.
ALTER TYPE provider_source_status ADD VALUE IF NOT EXISTS 'temporarily_closed';
