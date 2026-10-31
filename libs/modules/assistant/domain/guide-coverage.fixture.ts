/**
 * GoGo-BE#736 — the guide coverage set: questions people ask about using GoGo,
 * each with the document that must answer it. Typed both with and without
 * diacritics, the way people type in a chat.
 *
 * The documents below are **test fixtures, not product copy**: the onboarding
 * articles that go live are written and approved by owner/ops in the CMS. The
 * fixture only has to share the vocabulary a real article on the topic uses,
 * so a ranking change that stops a real article from being found fails here.
 */
import type { GuideDocumentForRanking } from './grounding';

const doc = (slug: string, title: string, description: string, body: string) => ({
  documentId: `doc-${slug}`,
  versionId: `ver-${slug}`,
  slug,
  title,
  description,
  body,
});

export const GUIDE_COVERAGE_DOCUMENTS: GuideDocumentForRanking[] = [
  doc(
    'rooms.create',
    'Tạo phòng',
    'Cách tạo phòng hẹn cho cặp đôi hoặc nhóm',
    '# Tạo phòng\nMở GoGo, chọn Tạo phòng, đặt tên phòng, chọn ngày giờ và khu vực.\n' +
      '## Sau khi tạo phòng\nBạn là chủ phòng và có thể đổi thông tin phòng bất cứ lúc nào.',
  ),
  doc(
    'rooms.invite',
    'Mời bạn vào phòng',
    'Cách mời người khác tham gia phòng',
    '# Mời bạn\nChủ phòng mở phòng, chọn Mời và chia sẻ liên kết mời cho người khác.\n' +
      '## Người được mời\nNgười nhận mở liên kết mời để vào phòng.',
  ),
  doc(
    'preferences',
    'Sở thích',
    'Cập nhật sở thích ăn uống, không khí và ngân sách',
    '# Sở thích của bạn\nVào hồ sơ, chọn Sở thích để cập nhật món ăn, đồ uống và không khí bạn thích.\n' +
      '## Đổi sở thích\nĐổi sở thích bất cứ lúc nào; gợi ý trong phòng dùng sở thích mới.',
  ),
  doc(
    'voting',
    'Bình chọn',
    'Bình chọn địa điểm trong phòng',
    '# Bình chọn địa điểm\nMỗi thành viên bình chọn địa điểm mình muốn; mỗi người một phiếu cho mỗi điểm.\n' +
      '## Kết quả bình chọn\nĐịa điểm nhiều phiếu nhất được đưa vào kế hoạch.',
  ),
  doc(
    'plans',
    'Kế hoạch buổi hẹn',
    'Xem và chốt kế hoạch',
    '# Xem kế hoạch\nKế hoạch buổi hẹn nằm trong phòng, gồm các điểm dừng theo thứ tự.\n' +
      '## Chốt kế hoạch\nChủ phòng chốt kế hoạch khi mọi người đã đồng ý.',
  ),
];

/** Each question must retrieve at least one section of `slug`. */
export const GUIDE_COVERAGE_CASES: readonly { question: string; slug: string }[] = [
  { question: 'Cách tạo phòng trên GoGo?', slug: 'rooms.create' },
  { question: 'lam the nao de tao phong', slug: 'rooms.create' },
  { question: 'Làm sao để mời bạn vào phòng?', slug: 'rooms.invite' },
  { question: 'moi nguoi khac vao phong the nao', slug: 'rooms.invite' },
  { question: 'Cập nhật sở thích ở đâu?', slug: 'preferences' },
  { question: 'doi so thich an uong', slug: 'preferences' },
  { question: 'Bình chọn địa điểm thế nào?', slug: 'voting' },
  { question: 'cach binh chon dia diem', slug: 'voting' },
  { question: 'Xem kế hoạch buổi hẹn ở đâu?', slug: 'plans' },
  { question: 'chot ke hoach the nao', slug: 'plans' },
];
