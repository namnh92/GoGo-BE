import { normalizeVietnamese } from '../../../search/domain/normalize';
import type { AnswerTopic, AnswerQuery } from './tokens';
import type { PlaceFactContext } from './place-facts';
import { renderPlaceAnswer } from './templates';
export const TOPIC_LABELS = {
  vi: {
    hours: 'Giờ mở cửa',
    price: 'Giá',
    address: 'Địa chỉ',
    directions: 'Đường đi',
    parking: 'Chỗ đậu xe',
    amenity: 'Tiện ích',
    suitability: 'Mức độ phù hợp',
    rating: 'Đánh giá',
    contact: 'Liên hệ',
    overview: 'Tổng quan',
    out_of_data: 'Thông tin khác',
  },
  en: {
    hours: 'Hours',
    price: 'Price',
    address: 'Address',
    directions: 'Directions',
    parking: 'Parking',
    amenity: 'Amenities',
    suitability: 'Suitability',
    rating: 'Ratings',
    contact: 'Contact',
    overview: 'Overview',
    out_of_data: 'Other information',
  },
} as const;

/** Exact emitted topic labels are ambiguous control fragments, never new questions. */
export function isTopicLabel(text: string): boolean {
  const t = normalizeVietnamese(text).trim();
  return Object.values(TOPIC_LABELS).some((labels) =>
    Object.values(labels).some((label) => normalizeVietnamese(label) === t),
  );
}
/** Semantic topic queries only. Eligibility is the SAME renderer policy as prose. */
export function eligibleTopicQueries(
  ids: readonly string[],
  locale: 'vi' | 'en',
  context: PlaceFactContext,
  excluded: AnswerTopic,
  now: Date,
): AnswerQuery[] {
  const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const candidates: Omit<AnswerQuery, 'placeId' | 'locale'>[] = [
    {
      topic: 'hours',
      day: 'date',
      date: local.toISOString().slice(0, 10),
      d: local.getUTCDay(),
      tz: 'Asia/Ho_Chi_Minh',
    },
    { topic: 'price' },
    { topic: 'address' },
    { topic: 'parking', k: 'parking' },
    { topic: 'amenity', k: 'wifi' },
    { topic: 'suitability' },
    { topic: 'rating' },
    { topic: 'contact' },
    { topic: 'overview' },
  ];
  return candidates
    .filter((q) => q.topic !== excluded)
    .flatMap((q) => {
      const query = ids
        .map((placeId) => ({ ...q, placeId, locale }))
        .find((query) => renderPlaceAnswer(query, context).eligible);
      return query ? [query] : [];
    })
    .slice(0, 3);
}
