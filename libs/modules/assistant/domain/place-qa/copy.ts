/** Closed, localized no-reference outcomes. No user text is interpolated. */
export const QA_COPY = {
  not_found: {
    vi: 'Mình chưa tìm thấy địa điểm tên này trong dữ liệu GoGo. Bạn kiểm tra lại tên giúp mình nhé.',
    en: 'I could not find this place in GoGo. Please check its name.',
  },
  narrow: {
    vi: 'Bạn cho mình tên chi nhánh hoặc phường/xã, tỉnh/thành hiện nay nhé.',
    en: 'Please give the branch or current ward and province.',
  },
  clarify_referent: {
    vi: 'Bạn muốn hỏi về địa điểm nào? Bạn gửi tên địa điểm giúp mình nhé.',
    en: 'Which place do you mean? Please send its name.',
  },
  stale_choice: {
    vi: 'Lựa chọn này không còn hợp lệ. Bạn gửi lại câu hỏi về địa điểm nhé.',
    en: 'This selection is no longer valid. Please ask about the place again.',
  },
  disabled: {
    vi: 'Tính năng trả lời địa điểm hiện chưa khả dụng.',
    en: 'Place questions are currently unavailable.',
  },
  unsupported: {
    vi: 'GoGo chưa hỗ trợ so sánh địa điểm. Bạn hỏi từng địa điểm giúp mình nhé.',
    en: 'GoGo does not support place comparisons yet. Please ask about one place at a time.',
  },
  retry: {
    vi: 'Bạn xác nhận đúng tên địa điểm hoặc chọn lại chi nhánh giúp mình nhé.',
    en: 'Please confirm the exact place name or select a branch.',
  },
  restate: {
    vi: 'Bạn gửi lại câu hỏi kèm tên địa điểm giúp mình nhé.',
    en: 'Please repeat your question with the place name.',
  },
  read_error: {
    vi: 'GoGo chưa tải được dữ liệu địa điểm. Bạn thử lại nhé.',
    en: 'GoGo could not load place data. Please try again.',
  },
} as const;
export type QaCopyKey = keyof typeof QA_COPY;
